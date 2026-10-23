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

package app

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/aggregator"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
)

// ReloadObserver records configuration reload outcomes, and whether the
// configuration file on disk would start the service.
type ReloadObserver interface {
	ConfigReloaded(result string)
	ConfigFileValid(valid bool)
}

// Reload results.
const (
	reloadApplied = "applied"
	reloadFailed  = "failed"
)

// EnableReload makes Run watch path for changes (when the configured
// interval is non-zero) and reload on every value received from hup
// (SIGHUP). Call before Run.
func (a *App) EnableReload(path string, hup <-chan os.Signal) {
	a.configPath, a.hup = path, hup
}

// watchConfig reloads when the file's content changes or on SIGHUP. An
// invalid file is reported once and the running configuration stays. Every
// watch tick also checks again whether the file on disk would start the
// service (ConfigFileValid), so an invalid file keeps showing as invalid
// until it is fixed: the next restart would fail with it.
func (a *App) watchConfig(ctx context.Context) {
	if a.configPath == "" {
		return
	}
	last, _ := fileHash(a.configPath)
	valid := true
	var tick <-chan time.Time
	if every := a.cfg.Reload.Interval(); every > 0 {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		tick = ticker.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.hup:
			last, _ = fileHash(a.configPath)
			valid = a.reloadAndReport(ctx, "signal")
		case <-tick:
			h, err := fileHash(a.configPath)
			if err == nil && h != last {
				last = h
				valid = a.reloadAndReport(ctx, "file change")
				continue
			}
			valid = a.checkFile(ctx, err, valid)
		}
	}
}

// checkFile reports whether the unchanged file on disk would start the
// service (readErr: the file could not be read), logs a change from
// wasValid, and returns the result.
func (a *App) checkFile(ctx context.Context, readErr error, wasValid bool) bool {
	err := readErr
	if err == nil {
		_, _, err = a.load()
	}
	valid := err == nil
	a.reloadObs.ConfigFileValid(valid)
	switch {
	case valid == wasValid:
	case valid:
		a.log.InfoContext(ctx, "the configuration file is valid again")
	default:
		a.log.ErrorContext(ctx, "the configuration file is no longer valid; a restart would fail with it",
			slog.Any("error", err))
	}
	return valid
}

// reloadAndReport reloads, reports the outcome and the file's validity, and
// returns whether it applied.
func (a *App) reloadAndReport(ctx context.Context, trigger string) bool {
	if err := a.Reload(ctx); err != nil {
		a.reloadObs.ConfigReloaded(reloadFailed)
		a.reloadObs.ConfigFileValid(false)
		a.log.ErrorContext(ctx, "configuration reload rejected; keeping the running configuration",
			slog.String("trigger", trigger), slog.Any("error", err))
		return false
	}
	a.reloadObs.ConfigReloaded(reloadApplied)
	a.reloadObs.ConfigFileValid(true)
	a.log.InfoContext(ctx, "configuration reloaded", slog.String("trigger", trigger),
		slog.Int("products", len(a.cfg.Products)))
	return true
}

// Reload loads the configuration file and applies it. Server and reload
// settings need a restart; changes to them are reported and ignored. The
// environment overrides (PORT) apply as they did at startup.
func (a *App) Reload(ctx context.Context) error {
	if a.configPath == "" {
		return errors.New("app: reload is not enabled")
	}
	next, bindings, err := a.load()
	if err != nil {
		return err
	}
	if changed := a.cfg.RestartRequired(next); len(changed) > 0 {
		a.log.WarnContext(ctx, "these settings take effect on restart only; keeping the running values",
			slog.Any("sections", changed))
		next.Server, next.Reload = a.cfg.Server, a.cfg.Reload
	}
	if err := a.agg.Apply(ctx, next, bindings); err != nil {
		return fmt.Errorf("app: apply: %w", err)
	}
	a.cfg = next
	return nil
}

// load reads the configuration file and builds its sources the way a start
// does: validation, the environment overrides and every adapter. It changes
// nothing.
func (a *App) load() (*config.Config, map[string]aggregator.Binding, error) {
	next, err := config.Load(a.configPath)
	if err != nil {
		return nil, nil, err
	}
	if err := next.ApplyEnvOverrides(a.getenv); err != nil {
		return nil, nil, err
	}
	bindings, err := buildBindings(next, a.registry, a.env)
	if err != nil {
		return nil, nil, err
	}
	return next, bindings, nil
}

func fileHash(path string) ([sha256.Size]byte, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // Operator-provided path.
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return sha256.Sum256(raw), nil
}
