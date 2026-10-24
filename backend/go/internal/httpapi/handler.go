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
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// RequestObserver records request telemetry. route is the matched pattern,
// never the raw path, so label cardinality stays bounded.
type RequestObserver interface {
	ObserveRequest(route string, code int, took time.Duration)
}

type nopRequestObserver struct{}

func (nopRequestObserver) ObserveRequest(string, int, time.Duration) {}

// Options configure the public handler.
type Options struct {
	Store                *Store
	CacheControl         string
	NotFoundCacheControl string
	AllowedOrigins       []string
	// MaxInFlight sheds requests beyond this concurrency with 503; 0 means
	// unlimited.
	MaxInFlight int
	// RequiredHeaders restricts the public API to callers that send these
	// exact headers (the CDN); probes are exempt.
	RequiredHeaders map[string]string
	Logger          *slog.Logger
	Observer        RequestObserver
}

type handler struct {
	store         *Store
	cacheControl  string
	notFoundCache string
}

// NewHandler returns the public API handler with its middleware.
func NewHandler(opts Options) http.Handler {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Observer == nil {
		opts.Observer = nopRequestObserver{}
	}
	h := &handler{store: opts.Store, cacheControl: opts.CacheControl, notFoundCache: opts.NotFoundCacheControl}
	if h.notFoundCache == "" {
		h.notFoundCache = noStore
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/summary", func(w http.ResponseWriter, r *http.Request) { h.serve(w, r, routeSummary) })
	mux.HandleFunc("GET /api/v1/incidents", func(w http.ResponseWriter, r *http.Request) { h.serve(w, r, routeIncidents) })
	mux.HandleFunc("GET /api/v1/products/{id}", func(w http.ResponseWriter, r *http.Request) {
		h.serve(w, r, routeProduct+r.PathValue("id"))
	})
	registerProbes(mux, opts.Store)
	mux.HandleFunc("/", h.fallback(mux))
	return chain(h.canonicalOnly(mux),
		recoverer(opts.Logger),
		securityHeaders,
		defaultCacheControl(h.notFoundCache),
		corsHeaders(opts.AllowedOrigins),
		requestID,
		shed(opts.MaxInFlight, opts.Observer),
		accessLog(opts.Logger, opts.Observer),
		originLock(opts.RequiredHeaders),
		preflight,
	)
}

const noStore = "no-store"

// NewAdminHandler serves probes and metrics on the internal listener, which
// is never exposed through the public ingress.
func NewAdminHandler(store *Store, metrics http.Handler) http.Handler {
	mux := http.NewServeMux()
	registerProbes(mux, store)
	if metrics != nil {
		mux.Handle("GET /metrics", metrics)
	}
	return mux
}

func registerProbes(mux *http.ServeMux, store *Store) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, `{"status":"ok"}`)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if snap := store.current.Load(); snap != nil && snap.ready {
			writeJSON(w, http.StatusOK, `{"status":"ready"}`)
			return
		}
		writeJSON(w, http.StatusServiceUnavailable, `{"status":"warming up"}`)
	})
}

func writeJSON(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", noStore)
	w.WriteHeader(code)
	_, _ = w.Write([]byte(body))
}

// fallback answers 405 for a known path with the wrong method and 404 for
// everything else. Registering "/" would otherwise turn every 405 into 404.
// 404s are cacheable so a CDN absorbs floods of random paths.
func (h *handler) fallback(mux *http.ServeMux) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		probe := r.Clone(r.Context())
		probe.Method = http.MethodGet
		if _, pattern := mux.Handler(probe); pattern != "/" {
			w.Header().Set("Allow", "GET, HEAD")
			problem(w, http.StatusMethodNotAllowed, noStore, "Method not allowed", "This resource only supports GET and HEAD.")
			return
		}
		problem(w, http.StatusNotFound, h.notFoundCache, "Not found", "No resource exists at this path.")
	}
}

// canonicalOnly answers a percent-encoded spelling of a path (one whose
// escaped form is not the default, so r.URL.RawPath is set) with the
// cacheable 404 for unknown paths, before routing. Ids are [a-z0-9-] and the
// page never encodes a path, so every such spelling would otherwise be a
// separate cache entry at the CDN, each answered with a full body.
func (h *handler) canonicalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawPath != "" {
			problem(w, http.StatusNotFound, h.notFoundCache, "Not found", "No resource exists at this path.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (h *handler) serve(w http.ResponseWriter, r *http.Request, key string) {
	snap := h.store.current.Load()
	if snap == nil {
		problem(w, http.StatusServiceUnavailable, noStore, "Warming up", "Status data has not been loaded yet. Retry shortly.")
		return
	}
	enc, ok := snap.routes[key]
	if !ok {
		problem(w, http.StatusNotFound, h.notFoundCache, "Not found", "No product exists with this id.")
		return
	}
	now := h.store.now()
	hdr := w.Header()
	hdr.Set("Content-Type", "application/json")
	hdr.Set("Cache-Control", h.cacheControl)
	hdr.Set("ETag", enc.etag)
	hdr.Set("Date", now.UTC().Format(http.TimeFormat))
	hdr.Set("Last-Modified", sentLastModified(enc, now).Format(http.TimeFormat))
	hdr.Add("Vary", "Accept-Encoding")
	if notModified(r, enc) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := enc.body
	if acceptsGzip(fieldValue(r.Header, "Accept-Encoding")) {
		hdr.Set("Content-Encoding", "gzip")
		body = enc.gz
	}
	hdr.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

// notModified evaluates conditional headers in RFC 9110 order:
// If-None-Match when present, otherwise If-Modified-Since.
func notModified(r *http.Request, enc *encoded) bool {
	if inm := fieldValue(r.Header, "If-None-Match"); inm != "" {
		return etagMatches(inm, enc.etag)
	}
	ims, err := http.ParseTime(r.Header.Get("If-Modified-Since"))
	return err == nil && !enc.modified.After(ims)
}

// fieldValue combines every line of a list-based request header into one
// value, in order and separated by commas, as RFC 9110 section 5.3 allows.
// Header.Get would read only the first line, so "Accept-Encoding: br"
// followed by "Accept-Encoding: gzip" would read as no gzip. Empty lines add
// no members and are skipped.
func fieldValue(h http.Header, name string) string {
	lines := h.Values(name)
	members := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			members = append(members, line)
		}
	}
	return strings.Join(members, ", ")
}

// etagMatches applies the weak comparison RFC 9110 requires for
// If-None-Match.
func etagMatches(header, etag string) bool {
	for _, tag := range strings.Split(header, ",") {
		tag = strings.TrimPrefix(strings.TrimSpace(tag), "W/")
		if tag == "*" || tag == etag {
			return true
		}
	}
	return false
}

// acceptsGzip reports whether the client accepts gzip (RFC 9110 section
// 12.5.3): an explicit gzip entry decides, otherwise "*" does, and a quality
// of 0 refuses. Malformed entries are ignored. testdata/http/
// accept-encoding.json holds the cases the handler and contract tests share.
func acceptsGzip(header string) bool {
	star, starSeen := false, false
	for entry := range strings.SplitSeq(header, ",") {
		coding, q, ok := parseCoding(entry)
		switch {
		case !ok:
		case coding == "gzip":
			return q > 0
		case coding == "*" && !starSeen:
			star, starSeen = q > 0, true
		}
	}
	return star
}

// qvalue is a weight: "q" (either case), then 0 to 1 with at most three
// decimals.
var qvalue = regexp.MustCompile(`^[qQ]=(0(\.[0-9]{0,3})?|1(\.0{0,3})?)$`)

// parseCoding reads one Accept-Encoding entry: the lowercased coding and its
// quality, 1 when absent. ok is false for a malformed entry.
func parseCoding(entry string) (coding string, q float64, ok bool) {
	coding, weight, weighted := strings.Cut(entry, ";")
	coding = strings.ToLower(strings.TrimSpace(coding))
	if coding == "" {
		return "", 0, false
	}
	if !weighted {
		return coding, 1, true
	}
	m := qvalue.FindStringSubmatch(strings.TrimSpace(weight))
	if m == nil {
		return "", 0, false
	}
	q, err := strconv.ParseFloat(m[1], 64)
	return coding, q, err == nil
}

// problem writes an RFC 9457 problem document.
func problem(w http.ResponseWriter, code int, cacheControl, title, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(code)
	_, _ = w.Write([]byte(`{"type":"about:blank","title":` + strconv.Quote(title) +
		`,"status":` + strconv.Itoa(code) + `,"detail":` + strconv.Quote(detail) + `}`))
}
