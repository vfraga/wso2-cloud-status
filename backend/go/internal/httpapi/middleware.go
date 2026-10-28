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

package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"time"
)

type middleware func(http.Handler) http.Handler

// chain applies middleware so the first listed is the outermost.
func chain(h http.Handler, mws ...middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

func recoverer(log *slog.Logger) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() { //nolint:contextcheck // False positive: the closure logs with r.Context().
				if v := recover(); v != nil {
					if v == http.ErrAbortHandler { //nolint:errorlint // Sentinel compared by identity, as net/http does.
						panic(v)
					}
					log.ErrorContext(r.Context(), "handler panic", slog.Any("panic", v), slog.String("request_id", requestIDFrom(r.Context())))
					problem(w, http.StatusInternalServerError, "Internal error", "The request could not be completed.")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

type ctxKey struct{}

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// requestID propagates a caller's X-Request-ID when it is well formed and
// generates one otherwise.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !validRequestID.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

func newRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.code == 0 {
		s.code = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.code == 0 {
		s.code = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// accessLog records telemetry for every request and logs server errors.
// Routine access logs belong to the edge, so 2xx-4xx log at debug only. It
// must pass r through unchanged: the mux sets r.Pattern on this request.
func accessLog(log *slog.Logger, obs RequestObserver) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			if rec.code == 0 {
				rec.code = http.StatusOK
			}
			took := time.Since(start)
			route := r.Pattern
			if route == "" || route == "/" {
				route = "unmatched"
			}
			obs.ObserveRequest(route, rec.code, took)
			level := slog.LevelDebug
			if rec.code >= http.StatusInternalServerError {
				level = slog.LevelError
			}
			log.Log(r.Context(), level, "request",
				slog.String("method", r.Method), slog.String("route", route), slog.Int("status", rec.code),
				slog.Duration("took", took), slog.String("request_id", requestIDFrom(r.Context())))
		})
	}
}

// isProbe reports whether the request is a liveness or readiness probe. The
// platform's probes pass the controls on public traffic: the origin lock
// and load shedding. A probe shed under load would read as a dead replica
// and get it restarted. The path is compared as sent, so an encoded spelling
// of a probe's path is not a probe.
func isProbe(r *http.Request) bool {
	path := r.URL.EscapedPath()
	return path == "/healthz" || path == "/readyz"
}

// shed rejects requests beyond max concurrent ones with 503, so a flood that
// bypasses the CDN degrades into fast refusals instead of queueing. Shed
// requests are observed under the route "shed". Probes are never shed.
func shed(limit int, obs RequestObserver) middleware {
	if limit <= 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	slots := make(chan struct{}, limit)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isProbe(r) {
				next.ServeHTTP(w, r)
				return
			}
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
				next.ServeHTTP(w, r)
			default:
				w.Header().Set("Retry-After", "1")
				problem(w, http.StatusServiceUnavailable, "Overloaded", "Too many requests in progress. Retry shortly.")
				obs.ObserveRequest("shed", http.StatusServiceUnavailable, 0)
			}
		})
	}
}

// originLock answers 403 unless each required header arrives exactly once
// with its value, so only the CDN can reach the public API. Refused requests
// are observed and logged as the access log would, under the route
// "unmatched", as they never reach routing. Probes stay open for the platform.
func originLock(required map[string]string, log *slog.Logger, obs RequestObserver) middleware {
	if len(required) == 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isProbe(r) {
				next.ServeHTTP(w, r)
				return
			}
			for name, want := range required {
				got := r.Header.Values(name)
				if len(got) != 1 || subtle.ConstantTimeCompare([]byte(got[0]), []byte(want)) != 1 {
					problem(w, http.StatusForbidden, "Forbidden", "Use the public status page address.")
					obs.ObserveRequest("unmatched", http.StatusForbidden, 0)
					log.DebugContext(r.Context(), "request",
						slog.String("method", r.Method), slog.String("route", "unmatched"),
						slog.Int("status", http.StatusForbidden), slog.Duration("took", 0),
						slog.String("request_id", requestIDFrom(r.Context())))
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// hsts keeps browsers on HTTPS for a year once they have reached the host
// over HTTPS, so an on-path attacker cannot strip a later redirect. It is
// safe behind Front Door, which terminates TLS and passes the header on:
// browsers ignore it over plain HTTP (RFC 6797 section 8.1), so a direct
// http:// request to the origin or a local run is unaffected.
// includeSubDomains covers only this host's own subdomains (RFC 6797 section
// 6.1.2). preload is left out: the preload list takes only a registrable
// domain, which belongs to its owners.
const hsts = "max-age=31536000; includeSubDomains"

// securityHeaders sets the security headers on every response of the public
// port, errors and refusals included.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Strict-Transport-Security", hsts)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		next.ServeHTTP(w, r)
	})
}

// defaultCacheControl gives every response a Cache-Control header, so a CDN
// never applies its own default to one: responses net/http writes for us
// (ServeMux's redirects for unclean paths) and preflights take this value.
// Handlers that set their own override it.
func defaultCacheControl(value string) middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", value)
			next.ServeHTTP(w, r)
		})
	}
}

// corsHeaders allows cross-origin reads of public data. Requests never carry
// credentials, so "*" is safe here. The headers go on every response, errors
// included, so a CDN never caches a copy without them: in "*" mode the
// allow-origin header, with an allow-list Vary: Origin.
func corsHeaders(allowed []string) middleware {
	allowAll := slices.Contains(allowed, "*")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			if allowAll {
				h.Set("Access-Control-Allow-Origin", "*")
			} else {
				h.Add("Vary", "Origin")
				if origin := r.Header.Get("Origin"); origin != "" && slices.Contains(allowed, origin) {
					h.Set("Access-Control-Allow-Origin", origin)
				}
			}
			// Date and Age let a cross-origin page measure the age of the
			// body's generated_at and checked_at on the server's clock (Date)
			// plus the time a cache held the response (Age), not the
			// visitor's clock.
			h.Set("Access-Control-Expose-Headers", "Date, Age, ETag, X-Request-ID")
			next.ServeHTTP(w, r)
		})
	}
}

// preflight answers CORS preflights (any OPTIONS request) for every path.
func preflight(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "If-None-Match, If-Modified-Since, X-Request-ID")
		h.Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
	})
}
