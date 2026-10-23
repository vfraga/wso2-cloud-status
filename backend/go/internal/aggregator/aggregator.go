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

// Package aggregator polls every source on its own schedule, keeps the last
// good data from each, and rebuilds the API views after every poll.
//
// One poll per source per interval serves every viewer: upstream load no
// longer grows with traffic, unlike the existing pages, where each browser
// polls the upstream API directly.
package aggregator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"math/rand/v2"
	"slices"
	"sync"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// Kind names one kind of data a source provides.
type Kind string

// Kinds of data, each polled on its own interval.
const (
	KindComponents Kind = "components"
	KindUptime     Kind = "uptime"
	KindIncidents  Kind = "incidents"
)

// Kinds lists every kind of data, in a fixed order.
func Kinds() []Kind {
	return []Kind{KindComponents, KindUptime, KindIncidents}
}

// Observer receives telemetry. Implementations must be safe for concurrent
// use.
type Observer interface {
	FetchDone(sourceKey string, kind Kind, took time.Duration, err error)
	Published(at time.Time)
}

// SourceObserver is an optional extension of Observer, told when a source is
// bound (at startup, or when a reload adds or changes it) and when a reload
// removes it. SourceBound gives, per kind, when the source last succeeded:
// the fetch time of the data a changed source keeps from its previous
// binding, or the bind time for a kind with no data. Calls are serialized
// with FetchDone for the same source, and FetchDone is never called for a
// source after it was removed.
type SourceObserver interface {
	SourceBound(sourceKey string, lastSuccess map[Kind]time.Time)
	SourceRemoved(sourceKey string)
}

// ProductObserver is an optional extension of Observer, told a product's
// status when it is first published and every time the published status
// changes, and told when a reload removes a product. Calls are serialized.
type ProductObserver interface {
	ProductStatus(productID string, status domain.Status)
	ProductRemoved(productID string)
}

// DataObserver is an optional extension of Observer, told about published
// data that is incomplete although every fetch may succeed. ProductData
// gives a product's data_complete and the sources it reads (SourceKey),
// when first published and whenever either changes; a removed product is
// reported to ProductObserver.ProductRemoved. SourceRegionKeys gives how
// many configured region keys a source's last answer lacks and how many it
// holds that no product configures, when first known and whenever either
// changes, never after SourceObserver.SourceRemoved for that source. Calls
// are serialized.
type DataObserver interface {
	ProductData(productID string, complete bool, sources []string)
	SourceRegionKeys(sourceKey string, missing, unmatched int)
}

type nopObserver struct{}

func (nopObserver) FetchDone(string, Kind, time.Duration, error) {}
func (nopObserver) Published(time.Time)                          {}

// Options tune an Aggregator; zero values take defaults.
type Options struct {
	Logger   *slog.Logger
	Observer Observer
	Clock    func() time.Time
	// Publish receives every build, in order. Required. An error means the
	// build was not published (the previous one is still served): the
	// Observer is then told nothing, so a service that stops publishing
	// shows in the snapshot-published telemetry.
	Publish func(Built) error
}

// Binding is a source plus a fingerprint of everything that defines its
// data (adapter type, endpoint, time zone, options, cloud). On Apply, an
// unchanged fingerprint keeps the source's data and polling loops.
type Binding struct {
	Source      source.Source
	Fingerprint string
}

// Aggregator owns the polling loops and the last good state.
type Aggregator struct {
	log     *slog.Logger
	obs     Observer
	now     func() time.Time
	publish func(Built) error

	mu       sync.Mutex
	cfg      *config.Config
	bindings map[string]Binding
	state    map[string]sourceState
	running  map[string]context.CancelFunc
	runCtx   context.Context //nolint:containedctx // Parent for loops started by Apply while running.
	stopped  bool
	loops    sync.WaitGroup
	buildMu  sync.Mutex
	// published is each product's last published status; buildMu guards it.
	published map[string]domain.Status
	// productData and regionKeys are what DataObserver was last told, per
	// product and per source; buildMu guards them.
	productData map[string]productData
	regionKeys  map[string]RegionKeys
	// held is each product's published checked_at (Built.held); buildMu
	// guards it.
	held map[string]heldCheck
}

// productData is what DataObserver.ProductData reports for one product.
type productData struct {
	complete bool
	sources  []string
}

// New returns an aggregator for the configured products. bindings maps
// every SourceKey the configuration uses to its source.
func New(cfg *config.Config, bindings map[string]Binding, opts Options) (*Aggregator, error) {
	if opts.Publish == nil {
		return nil, errors.New("aggregator: Options.Publish is required")
	}
	if err := checkBindings(cfg, bindings); err != nil {
		return nil, err
	}
	a := &Aggregator{
		log: opts.Logger, obs: opts.Observer, now: opts.Clock, publish: opts.Publish,
		cfg: cfg, bindings: maps.Clone(bindings), running: map[string]context.CancelFunc{},
		state: make(map[string]sourceState, len(bindings)),
	}
	if a.log == nil {
		a.log = slog.New(slog.DiscardHandler)
	}
	if a.obs == nil {
		a.obs = nopObserver{}
	}
	if a.now == nil {
		a.now = time.Now
	}
	now := a.now()
	for _, key := range slices.Sorted(maps.Keys(bindings)) {
		a.bindLocked(key, now)
	}
	return a, nil
}

// bindLocked binds key at the given time. A new source starts with no data.
// A source whose binding changed keeps its last good data, marked as
// inherited, until the new binding answers: each kind is replaced by that
// kind's first successful fetch (fetchInto), and inherited data ages and
// goes stale like any other. A SourceObserver is told, per kind, the fetch
// time of the data kept, or the bind time for a kind with none, so a
// rebind never makes a source look as if it had just answered.
func (a *Aggregator) bindLocked(key string, at time.Time) {
	st := a.state[key]
	st.components.inherited = st.components.ok()
	st.uptime.inherited = st.uptime.ok()
	st.incidents.inherited = st.incidents.ok()
	a.state[key] = st
	so, ok := a.obs.(SourceObserver)
	if !ok {
		return
	}
	since := func(kept time.Time) time.Time {
		if kept.IsZero() {
			return at
		}
		return kept
	}
	so.SourceBound(key, map[Kind]time.Time{
		KindComponents: since(st.components.at),
		KindUptime:     since(st.uptime.at),
		KindIncidents:  since(st.incidents.at),
	})
}

func checkBindings(cfg *config.Config, bindings map[string]Binding) error {
	for _, p := range cfg.Products {
		for _, ref := range p.Sources {
			if b, ok := bindings[SourceKey(ref)]; !ok || b.Source == nil {
				return fmt.Errorf("aggregator: no source for %s (product %s)", SourceKey(ref), p.ID)
			}
		}
	}
	return nil
}

// Apply swaps in a new catalogue and source set without a restart. Sources
// with an unchanged fingerprint keep their data and loops; removed sources
// stop; new or changed sources are polled at once. A changed source keeps
// serving its last good data until its new binding answers, so no build
// shows it empty while the first poll runs. A change to the polling
// settings restarts every loop but keeps all data.
func (a *Aggregator) Apply(ctx context.Context, cfg *config.Config, bindings map[string]Binding) error {
	if err := checkBindings(cfg, bindings); err != nil {
		return err
	}
	now := a.now()
	a.mu.Lock()
	next, fresh := a.reconcileLocked(bindings, now)
	if a.cfg.Polling != cfg.Polling {
		for key := range a.running {
			a.stopLocked(key)
		}
	}
	a.cfg, a.bindings = cfg, next
	a.mu.Unlock()

	a.refresh(ctx, fresh)
	a.mu.Lock()
	a.startMissingLocked(a.runCtx) //nolint:contextcheck // Loops live as long as Run, not as long as this call.
	a.mu.Unlock()
	a.Rebuild()
	return nil
}

// reconcileLocked stops the loops of the sources that were removed or whose
// fingerprint changed, forgets the removed ones, and binds the new or
// changed ones. Unchanged sources keep their binding, data and loops. It
// returns the bindings to keep and the keys that need an immediate poll.
func (a *Aggregator) reconcileLocked(bindings map[string]Binding, now time.Time) (map[string]Binding, []string) {
	next := maps.Clone(bindings)
	so, observes := a.obs.(SourceObserver)
	for key, old := range a.bindings {
		nb, kept := next[key]
		if !kept || nb.Fingerprint != old.Fingerprint {
			a.stopLocked(key)
		}
		if !kept {
			delete(a.state, key)
			if observes {
				so.SourceRemoved(key)
			}
		}
	}
	var fresh []string
	for _, key := range slices.Sorted(maps.Keys(next)) {
		if old, ok := a.bindings[key]; ok && old.Fingerprint == next[key].Fingerprint {
			next[key] = old
			continue
		}
		a.bindLocked(key, now)
		fresh = append(fresh, key)
	}
	return next, fresh
}

// RefreshAll polls every source for every kind once, then publishes.
func (a *Aggregator) RefreshAll(ctx context.Context) {
	a.mu.Lock()
	keys := slices.Collect(maps.Keys(a.bindings))
	a.mu.Unlock()
	a.refresh(ctx, keys)
	a.Rebuild()
}

// refresh polls the given sources for every kind, concurrently, and waits.
func (a *Aggregator) refresh(ctx context.Context, keys []string) {
	var wg sync.WaitGroup
	for _, key := range keys {
		for _, kind := range Kinds() {
			wg.Go(func() { _ = a.poll(ctx, key, kind) })
		}
	}
	wg.Wait()
}

// Run polls until ctx is done. The first round runs before the loops start,
// so the service is ready quickly.
func (a *Aggregator) Run(ctx context.Context) {
	a.mu.Lock()
	a.runCtx = ctx
	a.mu.Unlock()
	a.RefreshAll(ctx)
	a.mu.Lock()
	a.startMissingLocked(ctx)
	a.mu.Unlock()

	<-ctx.Done()
	a.mu.Lock()
	a.stopped = true
	for key := range a.running {
		a.stopLocked(key)
	}
	a.mu.Unlock()
	a.loops.Wait()
}

// startMissingLocked starts loops, children of parent, for every bound
// source without them. Before Run (nil parent) and after it, it does nothing.
func (a *Aggregator) startMissingLocked(parent context.Context) {
	if parent == nil || a.stopped {
		return
	}
	intervals := map[Kind]time.Duration{
		KindComponents: a.cfg.Polling.ComponentsInterval,
		KindUptime:     a.cfg.Polling.UptimeInterval,
		KindIncidents:  a.cfg.Polling.IncidentsInterval,
	}
	for key := range a.bindings {
		if _, ok := a.running[key]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(parent)
		a.running[key] = cancel
		for kind, every := range intervals {
			a.loops.Go(func() { a.loop(ctx, key, kind, every) })
		}
	}
}

func (a *Aggregator) stopLocked(key string) {
	if cancel, ok := a.running[key]; ok {
		cancel()
		delete(a.running, key)
	}
}

func (a *Aggregator) loop(ctx context.Context, key string, kind Kind, every time.Duration) {
	failures := 0
	if !a.succeeded(key, kind) {
		failures = 1
	}
	timer := time.NewTimer(nextDelay(every, failures))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if a.poll(ctx, key, kind) != nil {
				failures++
			} else {
				failures = 0
			}
			a.Rebuild()
			timer.Reset(nextDelay(every, failures))
		}
	}
}

// retryBase is the first retry delay after a failed poll.
const retryBase = time.Second

// nextDelay is the jittered interval after a success, and exponential
// backoff from retryBase, capped at the interval, after failures. A source
// that blips recovers in seconds instead of a full interval.
func nextDelay(every time.Duration, failures int) time.Duration {
	if failures == 0 {
		return jitter(every)
	}
	backoff := retryBase << min(failures-1, 16)
	return jitter(min(backoff, every))
}

// succeeded reports whether the current binding of key has fetched kind:
// data inherited from a replaced binding does not count, so a new binding
// whose first poll failed retries with backoff.
func (a *Aggregator) succeeded(key string, kind Kind) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	st := a.state[key]
	switch kind {
	case KindComponents:
		return st.components.ok() && !st.components.inherited
	case KindUptime:
		return st.uptime.ok() && !st.uptime.inherited
	default:
		return st.incidents.ok() && !st.incidents.inherited
	}
}

// jitter spreads polls by up to 10% so sources are not hit in lockstep.
func jitter(d time.Duration) time.Duration {
	spread := int64(d) / 10
	if spread <= 0 {
		return d
	}
	return d - time.Duration(spread/2) + time.Duration(rand.Int64N(spread)) //nolint:gosec // Scheduling jitter, not security.
}

func (a *Aggregator) poll(ctx context.Context, key string, kind Kind) error {
	a.mu.Lock()
	b, ok := a.bindings[key]
	timeout := a.cfg.Polling.RequestTimeout
	a.mu.Unlock()
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := a.now()
	var err error
	switch kind {
	case KindComponents:
		err = fetchInto(ctx, a, key, b, b.Source.Components, func(st *sourceState, v fetched[source.Components]) { st.components = v })
	case KindUptime:
		err = fetchInto(ctx, a, key, b, b.Source.Uptime, func(st *sourceState, v fetched[source.Uptime]) { st.uptime = v })
	case KindIncidents:
		err = fetchInto(ctx, a, key, b, b.Source.Incidents, func(st *sourceState, v fetched[source.Incidents]) { st.incidents = v })
	}
	if cancelled(ctx, err) {
		return err
	}
	a.report(key, b, kind, a.now().Sub(start), err)
	if err != nil {
		a.log.WarnContext(ctx, "upstream fetch failed; keeping last good data",
			slog.String("source", key), slog.String("kind", string(kind)), slog.Any("error", err))
	}
	return err
}

// cancelled reports whether a poll failed because a reload or a shutdown
// cancelled it. That says nothing about the upstream, so it is neither
// counted nor logged. A timeout (context.DeadlineExceeded) is not a
// cancellation: it still counts as a failed fetch.
func cancelled(ctx context.Context, err error) bool {
	return err != nil && errors.Is(err, context.Canceled) && errors.Is(ctx.Err(), context.Canceled)
}

// fetchInto stores a successful fetch, unless the binding changed while the
// request was in flight: data from a replaced source is discarded.
func fetchInto[T any](ctx context.Context, a *Aggregator, key string, b Binding, get func(context.Context) (T, error), set func(*sourceState, fetched[T])) error {
	data, err := get(ctx)
	if err != nil {
		return err
	}
	at := a.now()
	a.mu.Lock()
	defer a.mu.Unlock()
	if cur, ok := a.bindings[key]; !ok || cur.Fingerprint != b.Fingerprint {
		return nil
	}
	st := a.state[key]
	set(&st, fetched[T]{data: data, at: at})
	a.state[key] = st
	return nil
}

// report tells the observer about a fetch while the binding that made it is
// still current. It holds the lock, so a removal is never followed by
// telemetry that would bring the removed source's series back.
func (a *Aggregator) report(key string, b Binding, kind Kind, took time.Duration, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if cur, ok := a.bindings[key]; ok && cur.Fingerprint == b.Fingerprint {
		a.obs.FetchDone(key, kind, took, err)
	}
}

// Rebuild derives the views from the current state and publishes them.
// Builds are serialized so a slower, older build never overwrites a newer
// one. Only a build that was published reaches the Observer.
func (a *Aggregator) Rebuild() {
	a.buildMu.Lock()
	defer a.buildMu.Unlock()
	a.mu.Lock()
	snapshot := maps.Clone(a.state)
	cfg := a.cfg
	a.mu.Unlock()
	now := a.now()
	built := build(buildParams{
		products: cfg.Products,
		state:    snapshot,
		now:      now,
		stale:    stalenessOf(cfg.Polling),
		days:     cfg.History.Days,
		held:     a.held,
	})
	if a.publish(built) != nil {
		return
	}
	a.held = built.held
	a.obs.Published(now)
	a.trackStatuses(built.Summary.Products)
	a.trackProductData(built.Summary.Products, cfg)
	a.trackRegionKeys(built.RegionKeys)
}

// trackProductData tells a DataObserver each published product's
// data_complete and sources when they are new or changed. The caller holds
// buildMu.
func (a *Aggregator) trackProductData(products []ProductSummary, cfg *config.Config) {
	do, observes := a.obs.(DataObserver)
	if !observes {
		return
	}
	sources := make(map[string][]string, len(cfg.Products))
	for _, p := range cfg.Products {
		for _, ref := range p.Sources {
			sources[p.ID] = append(sources[p.ID], SourceKey(ref))
		}
	}
	current := make(map[string]productData, len(products))
	for _, p := range products {
		pd := productData{complete: p.DataComplete, sources: sources[p.ID]}
		current[p.ID] = pd
		if prev, seen := a.productData[p.ID]; seen && prev.complete == pd.complete && slices.Equal(prev.sources, pd.sources) {
			continue
		}
		do.ProductData(p.ID, pd.complete, pd.sources)
	}
	a.productData = current
}

// trackRegionKeys logs, once per change, each source whose region keys
// differ from the configuration (and when they match again), and tells a
// DataObserver. It holds mu while reporting, so a source a reload removed
// meanwhile is skipped rather than given new telemetry. The caller holds
// buildMu.
func (a *Aggregator) trackRegionKeys(keys map[string]RegionKeys) {
	do, observes := a.obs.(DataObserver)
	a.mu.Lock()
	defer a.mu.Unlock()
	for key := range a.regionKeys {
		if _, bound := a.bindings[key]; !bound {
			delete(a.regionKeys, key)
		}
	}
	if a.regionKeys == nil {
		a.regionKeys = map[string]RegionKeys{}
	}
	for _, key := range slices.Sorted(maps.Keys(keys)) {
		rk := keys[key]
		prev, seen := a.regionKeys[key]
		if _, bound := a.bindings[key]; !bound || seen && slices.Equal(prev.Missing, rk.Missing) && slices.Equal(prev.Unmatched, rk.Unmatched) {
			continue
		}
		a.regionKeys[key] = rk
		a.logRegionKeys(key, rk, seen)
		if observes {
			do.SourceRegionKeys(key, len(rk.Missing), len(rk.Unmatched))
		}
	}
}

// logRegionKeys warns when a source's region keys differ from the
// configuration, and says so at info when they match again.
func (a *Aggregator) logRegionKeys(key string, rk RegionKeys, before bool) {
	if len(rk.Missing) == 0 && len(rk.Unmatched) == 0 {
		if before {
			a.log.Info("upstream region keys match the configuration again", slog.String("source", key))
		}
		return
	}
	a.log.Warn("upstream region keys differ from the configuration; check the region keys in the configuration",
		slog.String("source", key), slog.Any("missing", rk.Missing), slog.Any("unmatched", rk.Unmatched))
}

// trackStatuses logs every published product status that is new or
// changed at info, so the logs show what the page said and when, and tells
// a ProductObserver. The caller holds buildMu.
func (a *Aggregator) trackStatuses(products []ProductSummary) {
	po, observes := a.obs.(ProductObserver)
	current := make(map[string]domain.Status, len(products))
	for _, p := range products {
		current[p.ID] = p.Status
		prev, seen := a.published[p.ID]
		if seen && prev == p.Status {
			continue
		}
		a.logStatus(p.ID, prev, seen, p.Status)
		if observes {
			po.ProductStatus(p.ID, p.Status)
		}
	}
	for id := range a.published {
		if _, kept := current[id]; !kept && observes {
			po.ProductRemoved(id)
		}
	}
	a.published = current
}

// logStatus logs a product's published status, and the one it replaces
// unless this is the product's first.
func (a *Aggregator) logStatus(id string, from domain.Status, replaces bool, to domain.Status) {
	const msg = "product status changed"
	if !replaces {
		a.log.Info(msg, slog.String("product", id), slog.String("to", to.String()))
		return
	}
	a.log.Info(msg, slog.String("product", id), slog.String("from", from.String()), slog.String("to", to.String()))
}
