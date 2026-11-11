// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

// Package app wires configuration, sources, the aggregator and the HTTP
// servers into one runnable service.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/httpapi"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/telemetry"
)

// App is the assembled service.
type App struct {
	cfg *config.Config
	// server is the configuration the listeners started with. Server
	// settings need a restart, and Run reads them while a reload may be
	// replacing cfg.
	server   config.Server
	getenv   func(string) string
	log      *slog.Logger
	agg      *aggregator.Aggregator
	registry *source.Registry
	env      source.Env
	// providers are the running backends' providers, kept across reloads
	// while their backend is unchanged (buildBindings).
	providers map[string]built
	// configSum is the SHA-256 of the file the last reload applied, and
	// restartPending the sections of it that still wait for a restart.
	configSum      string
	restartPending []string
	reloadObs      ReloadObserver
	public         *http.Server
	admin          *http.Server
	publicLn       net.Listener
	adminLn        net.Listener

	configPath string
	hup        <-chan os.Signal
	// ticks, when set, replaces the watch ticker (tests send the ticks).
	ticks <-chan time.Time
}

// Load reads the configuration file at path with the default adapters, as
// a start, -check-config and every reload do (load), and returns it with
// the file's SHA-256 in hex.
func Load(path string, getenv func(string) string) (*config.Config, string, error) {
	l, err := load(path, getenv, DefaultRegistry(), source.Env{HTTPClient: upstreamClient()}, nil)
	if err != nil {
		return nil, "", err
	}
	return l.cfg, l.sum, nil
}

// loaded is a configuration file read, checked and bound to its sources.
type loaded struct {
	cfg       *config.Config
	sum       string // the file's SHA-256, hex
	bindings  map[string]aggregator.Binding
	providers map[string]built
}

// load reads the configuration file at path and expands ${NAME}, applies
// the environment overrides (PORT), builds every source through its
// backend's adapter, reusing prev's providers for unchanged backends
// (buildBindings), and validates the result, reporting every problem at
// once. It performs no I/O besides reading the file.
func load(path string, getenv func(string) string, reg *source.Registry, env source.Env, prev map[string]built) (loaded, error) {
	cfg, sum, err := config.Read(path)
	if err != nil {
		return loaded{}, err
	}
	cfg.ApplyEnvOverrides(getenv)
	bindings, providers, adapterErr := buildBindings(cfg, reg, env, prev)
	if err := errors.Join(cfg.Validate(), adapterErr); err != nil {
		return loaded{}, err
	}
	return loaded{cfg: cfg, sum: sum, bindings: bindings, providers: providers}, nil
}

// New assembles the service with the default adapters. It performs no I/O.
func New(cfg *config.Config, log *slog.Logger, version string) (*App, error) {
	return NewWithRegistry(cfg, log, version, DefaultRegistry())
}

// NewWithRegistry assembles the service with the given adapters.
func NewWithRegistry(cfg *config.Config, log *slog.Logger, version string, reg *source.Registry) (*App, error) {
	metrics := telemetry.New(version)
	metrics.OriginLock(len(cfg.Server.RequiredHeaders) > 0)
	env := source.Env{HTTPClient: upstreamClient(), UserAgent: "wso2-cloud-statusd/" + version}
	bindings, providers, err := buildBindings(cfg, reg, env, nil)
	if err != nil {
		return nil, err
	}
	store := &httpapi.Store{}
	agg, err := aggregator.New(cfg, bindings, aggregator.Options{
		Logger:   log,
		Observer: metrics,
		Publish: func(b aggregator.Built) error {
			if err := store.Publish(b); err != nil {
				log.Error("publish failed; serving the previous snapshot", slog.Any("error", err))
				return err
			}
			return nil
		},
	})
	if err != nil {
		return nil, err
	}
	public := httpapi.NewHandler(httpapi.Options{
		Store: store, CacheControl: cfg.Server.CacheControl,
		AllowedOrigins: cfg.Server.AllowedOrigins, MaxInFlight: cfg.Server.MaxInFlight,
		RequiredHeaders: cfg.Server.RequiredHeaders, Logger: log, Observer: metrics,
	})
	return &App{
		cfg:       cfg,
		server:    cfg.Server,
		getenv:    os.Getenv,
		log:       log,
		agg:       agg,
		registry:  reg,
		env:       env,
		providers: providers,
		reloadObs: metrics,
		public:    newServer(public, log),
		admin:     newServer(httpapi.NewAdminHandler(store, metrics.Handler()), log),
	}, nil
}

// maxHeaderBytes is above the largest request head Front Door forwards (64 KB
// of headers and an 8 KB URL) plus the headers it and the ingress add, so an
// oversized request is refused at the edge. net/http's own 431 carries no
// Cache-Control, and an edge cache could keep it in place of a real answer.
const maxHeaderBytes = 128 << 10

func newServer(h http.Handler, log *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
		// OPTIONS * goes to the handler, with its headers and origin lock,
		// rather than net/http's own empty 200.
		DisableGeneralOptionsHandler: true,
	}
}

// Listen binds both listeners, so port problems surface before polling
// starts. Run calls it when the caller has not.
func (a *App) Listen(ctx context.Context) error {
	var lc net.ListenConfig
	var err error
	if a.publicLn, err = lc.Listen(ctx, "tcp", a.server.Addr); err != nil {
		return fmt.Errorf("app: listen %s: %w", a.server.Addr, err)
	}
	if a.adminLn, err = lc.Listen(ctx, "tcp", a.server.AdminAddr); err != nil {
		_ = a.publicLn.Close()
		return fmt.Errorf("app: listen %s: %w", a.server.AdminAddr, err)
	}
	return nil
}

// Addr is the bound public address; valid after Listen.
func (a *App) Addr() net.Addr { return a.publicLn.Addr() }

// AdminAddr is the bound admin address; valid after Listen.
func (a *App) AdminAddr() net.Addr { return a.adminLn.Addr() }

// Run serves and polls until ctx is done or a server fails, then shuts down
// gracefully within the configured timeout.
func (a *App) Run(ctx context.Context) error {
	if a.publicLn == nil {
		if err := a.Listen(ctx); err != nil {
			return err
		}
	}
	// Logged before the watcher starts: from then on only the watcher reads
	// or replaces a.cfg.
	a.log.InfoContext(ctx, "serving", slog.String("public", a.Addr().String()), slog.String("admin", a.AdminAddr().String()))
	a.logOriginLock(ctx)
	a.log.InfoContext(ctx, "sources", slog.Any("hosts", backendHosts(a.cfg)))

	errs := make(chan error, 2)
	go func() { errs <- serve(a.public, a.publicLn) }()
	go func() { errs <- serve(a.admin, a.adminLn) }()

	pollCtx, stopPolling := context.WithCancel(ctx)
	polled := make(chan struct{})
	go func() {
		a.agg.Run(pollCtx)
		close(polled)
	}()
	watched := make(chan struct{})
	go func() {
		a.watchConfig(pollCtx)
		close(watched)
	}()

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errs:
	}
	a.log.InfoContext(ctx, "shutting down")
	stopPolling()
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), a.server.ShutdownTimeout)
	defer cancel()
	err := errors.Join(runErr, a.public.Shutdown(shutdownCtx), a.admin.Shutdown(shutdownCtx))
	<-polled
	<-watched
	return err
}

// logOriginLock says whether the public port is locked to the CDN, naming
// the required headers but never their values. Off is logged as an error:
// behind Front Door it means the WAF and its rate limits can be bypassed.
func (a *App) logOriginLock(ctx context.Context) {
	if len(a.server.RequiredHeaders) == 0 {
		a.log.ErrorContext(ctx, "origin lock off: the public port answers requests that did not come through the CDN")
		return
	}
	a.log.InfoContext(ctx, "origin lock on", slog.Any("headers", slices.Sorted(maps.Keys(a.server.RequiredHeaders))))
}

func serve(srv *http.Server, ln net.Listener) error {
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// ParseLevel maps a log level name to a slog level; empty means info.
func ParseLevel(name string) (slog.Level, error) {
	var level slog.Level
	if strings.TrimSpace(name) == "" {
		return slog.LevelInfo, nil
	}
	if err := level.UnmarshalText([]byte(name)); err != nil {
		return slog.LevelInfo, fmt.Errorf("app: log level %q: %w", name, err)
	}
	return level, nil
}

// backendHosts names, per backend, the hosts it sends requests to: its base
// URL's and those of its options ending in "_url" (a token endpoint), so the
// log shows where each credential goes.
func backendHosts(cfg *config.Config) map[string][]string {
	hosts := map[string][]string{}
	for name, b := range cfg.Backends {
		raw := []string{b.BaseURL}
		for _, k := range slices.Sorted(maps.Keys(b.Options)) {
			if strings.HasSuffix(k, "_url") {
				raw = append(raw, b.Options[k])
			}
		}
		for _, r := range raw {
			if u, err := url.Parse(r); err == nil && u.Host != "" && !slices.Contains(hosts[name], u.Host) {
				hosts[name] = append(hosts[name], u.Host)
			}
		}
	}
	return hosts
}
