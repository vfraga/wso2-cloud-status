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

// Command statusd serves the WSO2 Cloud status API.
//
// Usage:
//
//	statusd [-config file]       serve (the default file is $STATUSD_CONFIG, else config/statusd.yaml)
//	statusd -check-config file   check a configuration file and exit
//	statusd -version             print the version and exit
//
// -check-config does everything a start does with the file except bind the
// ports and poll: it reads it, expands ${NAME} from the environment, applies
// PORT, builds every source through its adapter, and validates. Set every
// variable the file references (a placeholder value is enough). Exit codes:
// 0 the file would start the service, 1 it would not (every reason goes to
// stderr), 2 the command line is wrong.
//
// Serving exits 2 when the configuration is rejected at startup, logging
// "configuration rejected" with every problem, and 1 when it cannot bind
// its ports or stops with an error.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"os/signal"
	"slices"
	"syscall"
	_ "time/tzdata" // Backends name time zones; do not depend on the image's zoneinfo.

	"github.com/wso2/wso2-cloud-status/backend/go/internal/app"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// Exit codes of -check-config.
const (
	checkValid   = 0
	checkInvalid = 1
	usageError   = 2
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("statusd", flag.ContinueOnError)
	flags.SetOutput(stderr)
	configPath := flags.String("config", envOr("STATUSD_CONFIG", "config/statusd.yaml"), "path to the configuration file")
	checkPath := flags.String("check-config", "", "check the configuration `file` the way a start would, without binding ports or polling, then exit: 0 valid, 1 invalid")
	showVersion := flags.Bool("version", false, "print the version and exit")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return usageError
	}
	switch {
	case *showVersion:
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	case *checkPath != "":
		return checkConfig(*checkPath, os.Getenv, stdout, stderr)
	default:
		return serve(*configPath, stdout)
	}
}

// checkConfig loads the file as a start does (load); no port is bound and
// no source is polled.
func checkConfig(path string, getenv func(string) string, stdout, stderr io.Writer) int {
	cfg, _, err := load(path, getenv, slog.New(slog.DiscardHandler))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "%s is invalid: %v\n", path, err)
		return checkInvalid
	}
	lock := "off"
	if len(cfg.Server.RequiredHeaders) > 0 {
		lock = fmt.Sprintf("on %v", slices.Sorted(maps.Keys(cfg.Server.RequiredHeaders)))
	}
	_, _ = fmt.Fprintf(stdout, "%s is valid: %d products, origin lock %s\n", path, len(cfg.Products), lock)
	return checkValid
}

func serve(configPath string, stdout io.Writer) int {
	level, levelErr := app.ParseLevel(os.Getenv("STATUSD_LOG_LEVEL"))
	log := slog.New(slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: level})).With(slog.String("version", version))
	if levelErr != nil {
		log.Warn("ignoring STATUSD_LOG_LEVEL", slog.Any("error", levelErr))
	}

	_, a, err := load(configPath, os.Getenv, log)
	if err != nil {
		log.Error("configuration rejected", slog.Any("error", err))
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	a.EnableReload(configPath, hup)
	if err := a.Run(ctx); err != nil {
		log.Error("stopped with error", slog.Any("error", err))
		return 1
	}
	return 0
}

// load reads the configuration file (app.Load) and assembles the service
// from it, which performs no I/O. A start and -check-config both use it, so
// every error is a problem with the file or the environment it reads.
func load(path string, getenv func(string) string, log *slog.Logger) (*config.Config, *app.App, error) {
	cfg, err := app.Load(path, getenv)
	if err != nil {
		return nil, nil, err
	}
	a, err := app.New(cfg, log, version)
	if err != nil {
		return nil, nil, err
	}
	return cfg, a, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
