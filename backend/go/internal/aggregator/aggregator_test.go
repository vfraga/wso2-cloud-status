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

package aggregator

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

type recorder struct {
	mu     sync.Mutex
	builds []Built
	errs   atomic.Int64
	pubs   atomic.Int64
}

func (r *recorder) publish(b Built) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.builds = append(r.builds, b)
	return nil
}

func (r *recorder) last() Built {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.builds[len(r.builds)-1]
}

func (r *recorder) FetchDone(_ string, _ Kind, _ time.Duration, err error) {
	if err != nil {
		r.errs.Add(1)
	}
}

func (r *recorder) Published(time.Time) { r.pubs.Add(1) }

// sourceRecorder also implements the optional SourceObserver.
type sourceRecorder struct {
	recorder
	mu      sync.Mutex
	events  []string
	fetched []string
}

// SourceBound records "bound <key> <components> <uptime> <incidents>".
func (r *sourceRecorder) SourceBound(key string, lastSuccess map[Kind]time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	event := append(make([]string, 0, 5), "bound", key)
	for _, kind := range Kinds() {
		event = append(event, lastSuccess[kind].Format(time.TimeOnly))
	}
	r.events = append(r.events, strings.Join(event, " "))
}

func (r *sourceRecorder) SourceRemoved(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, "removed "+key)
}

func (r *sourceRecorder) FetchDone(key string, kind Kind, took time.Duration, err error) {
	r.recorder.FetchDone(key, kind, took, err)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fetched = append(r.fetched, key)
}

func (r *sourceRecorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events
	r.events = nil
	return out
}

func fakes() (map[string]Binding, map[string]*fakeSource) {
	raw := map[string]*fakeSource{
		"b/s1": {components: healthy("us", "eu")},
		"b/s2": {components: healthy("cp")},
		"b/s3": {components: healthy("cp")},
	}
	out := map[string]Binding{}
	for k, v := range raw {
		out[k] = Binding{Source: v, Fingerprint: k + "@v1"}
	}
	return out, raw
}

func TestNewValidates(t *testing.T) {
	t.Parallel()
	srcs, _ := fakes()
	if _, err := New(testConfig(), srcs, Options{}); err == nil {
		t.Fatal("expected an error without Publish")
	}
	delete(srcs, "b/s3")
	if _, err := New(testConfig(), srcs, Options{Publish: func(Built) error { return nil }}); err == nil {
		t.Fatal("expected an error for a missing source")
	}
}

func TestRefreshAllKeepsLastGoodDataOnFailure(t *testing.T) {
	t.Parallel()
	srcs, raw := fakes()
	rec := &recorder{}
	now := t0
	a, err := New(testConfig(), srcs, Options{Publish: rec.publish, Observer: rec, Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	a.RefreshAll(context.Background())
	if b := rec.last(); !b.Ready || b.Summary.Status != domain.StatusOperational {
		t.Fatalf("first build = ready %v status %v", b.Ready, b.Summary.Status)
	}
	raw["b/s1"].set(func(f *fakeSource) { f.fail = true })
	now = t0.Add(time.Minute)
	a.RefreshAll(context.Background())
	if got := rec.last().Products["one"].Status; got != domain.StatusOperational {
		t.Fatalf("within stale_after, last good data must be served; got %v", got)
	}
	if rec.errs.Load() != 3 {
		t.Fatalf("observed errors = %d, want 3 (one per kind)", rec.errs.Load())
	}
	now = t0.Add(10 * time.Minute)
	a.Rebuild()
	if got := rec.last().Products["one"].Status; got != domain.StatusUnknown {
		t.Fatalf("past stale_after, status must be unknown; got %v", got)
	}
}

func TestRunPollsUntilCancelled(t *testing.T) {
	t.Parallel()
	srcs, raw := fakes()
	rec := &recorder{}
	a, err := New(testConfig(), srcs, Options{Publish: rec.publish, Observer: rec})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.Run(ctx)
		close(done)
	}()
	deadline := time.After(5 * time.Second)
	for rec.pubs.Load() < 10 {
		select {
		case <-deadline:
			t.Fatalf("only %d builds published", rec.pubs.Load())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
	raw["b/s1"].set(func(f *fakeSource) {
		if f.calls < 4 {
			t.Errorf("s1 polled %d times, want repeated polling", f.calls)
		}
	})
}

func TestNextDelayBacksOffAndCaps(t *testing.T) {
	t.Parallel()
	within := func(got, want time.Duration) bool { return got >= want*95/100 && got <= want*105/100 }
	cases := []struct {
		failures int
		want     time.Duration
	}{{0, 30 * time.Second}, {1, time.Second}, {2, 2 * time.Second}, {3, 4 * time.Second}, {6, 30 * time.Second}, {100, 30 * time.Second}}
	for _, c := range cases {
		if got := nextDelay(30*time.Second, c.failures); !within(got, c.want) {
			t.Errorf("nextDelay(30s, %d) = %v, want about %v", c.failures, got, c.want)
		}
	}
}

func TestFailedSourceRecoversBeforeTheInterval(t *testing.T) {
	t.Parallel()
	srcs, raw := fakes()
	raw["b/s1"].set(func(f *fakeSource) { f.fail = true })
	cfg := slowConfig()
	rec := &recorder{}
	a, err := New(cfg, srcs, Options{Publish: rec.publish, Observer: rec})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.Run(ctx)
	deadline := time.After(5 * time.Second)
	for rec.pubs.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("no build published")
		case <-time.After(5 * time.Millisecond):
		}
	}
	raw["b/s1"].set(func(f *fakeSource) { f.fail = false })
	for rec.last().Products["one"].Status != domain.StatusOperational {
		select {
		case <-deadline:
			t.Fatal("source did not recover within the backoff window (interval is 1h)")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestJitterStaysWithinTenPercent(t *testing.T) {
	t.Parallel()
	for range 1000 {
		got := jitter(time.Second)
		if got < 950*time.Millisecond || got > 1050*time.Millisecond {
			t.Fatalf("jitter(1s) = %v", got)
		}
	}
	if got := jitter(5 * time.Nanosecond); got != 5*time.Nanosecond {
		t.Fatalf("jitter(5ns) = %v", got)
	}
}

func (f *fakeSource) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// slowConfig polls hourly, so only Run's first round and Apply poll.
func slowConfig() *config.Config {
	cfg := testConfig()
	cfg.Polling.ComponentsInterval, cfg.Polling.UptimeInterval, cfg.Polling.IncidentsInterval = time.Hour, time.Hour, time.Hour
	cfg.Polling.RequestTimeout = time.Second
	return cfg
}

func startRunning(t *testing.T, cfg *config.Config, bindings map[string]Binding) (*Aggregator, *recorder) {
	t.Helper()
	rec := &recorder{}
	a, err := New(cfg, bindings, Options{Publish: rec.publish, Observer: rec})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	for deadline := time.Now().Add(5 * time.Second); rec.pubs.Load() == 0; {
		if time.Now().After(deadline) {
			t.Fatal("no build published")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return a, rec
}

func TestApplyAddsAndRemovesWithoutTouchingUnchangedSources(t *testing.T) {
	t.Parallel()
	bindings, raw := fakes()
	a, rec := startRunning(t, slowConfig(), bindings)
	s1Before := raw["b/s1"].callCount()

	next := slowConfig()
	next.Products = []config.Product{
		next.Products[0],
		{ID: "three", Name: "Three", Sources: []config.SourceRef{
			{Backend: "b", Cloud: "s4", Regions: []config.RegionRef{{Key: "ap", ID: "ap", Name: "AP"}}},
		}},
	}
	s4 := &fakeSource{components: healthy("ap")}
	err := a.Apply(context.Background(), next, map[string]Binding{
		"b/s1": {Source: &fakeSource{}, Fingerprint: "b/s1@v1"},
		"b/s4": {Source: s4, Fingerprint: "b/s4@v1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	b := rec.last()
	if _, ok := b.Products["two"]; ok || len(b.Summary.Products) != 2 {
		t.Fatalf("products after Apply = %v", b.Summary.Products)
	}
	if got := b.Products["three"].Status; got != domain.StatusOperational || s4.callCount() != 3 {
		t.Fatalf("new product status %v after %d polls; want operational after an immediate round", got, s4.callCount())
	}
	if raw["b/s1"].callCount() != s1Before || b.Products["one"].Status != domain.StatusOperational {
		t.Fatal("an unchanged source must keep its data and its original source, and not be re-polled")
	}
}

func TestApplyChangedFingerprintReplacesData(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	a, rec := startRunning(t, slowConfig(), bindings)
	degraded := &fakeSource{components: source.Components{
		"us": {group(domain.StatusDegraded)}, "eu": {group(domain.StatusOperational)},
	}}
	bindings["b/s1"] = Binding{Source: degraded, Fingerprint: "b/s1@v2"}
	if err := a.Apply(context.Background(), slowConfig(), bindings); err != nil {
		t.Fatal(err)
	}
	if got := rec.last().Products["one"].Status; got != domain.StatusDegraded {
		t.Fatalf("status after a changed source = %v, want degraded from the new source", got)
	}
}

// slowSource blocks Components until gate closes and closes entered when
// the first call starts; its other kinds answer at once.
type slowSource struct {
	fakeSource
	gate    chan struct{}
	entered chan struct{}
	once    sync.Once
}

func (s *slowSource) Components(ctx context.Context) (source.Components, error) {
	s.once.Do(func() { close(s.entered) })
	<-s.gate
	return s.fakeSource.Components(ctx)
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.builds)
}

func (r *recorder) since(n int) []Built {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.builds[n:])
}

// TestApplyChangedFingerprintKeepsDataUntilTheNewBindingAnswers: while the
// new binding's first poll is slow, the other sources' loops keep
// publishing, and every build they publish still shows the changed source's
// last good data; once the new binding answers, its data replaces it.
func TestApplyChangedFingerprintKeepsDataUntilTheNewBindingAnswers(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	cfg := testConfig()
	cfg.Polling.RequestTimeout = 10 * time.Second
	a, rec := startRunning(t, cfg, bindings)
	slow := &slowSource{
		fakeSource: fakeSource{components: source.Components{"us": {group(domain.StatusDegraded)}, "eu": {group(domain.StatusOperational)}}},
		gate:       make(chan struct{}), entered: make(chan struct{}),
	}
	bindings["b/s1"] = Binding{Source: slow, Fingerprint: "b/s1@v2"}
	applied := make(chan error, 1)
	go func() { applied <- a.Apply(context.Background(), cfg, bindings) }()
	<-slow.entered
	from := rec.count()
	for deadline := time.Now().Add(5 * time.Second); rec.count() < from+5; {
		if time.Now().After(deadline) {
			t.Fatalf("only %d builds published while the new binding was slow", rec.count()-from)
		}
		time.Sleep(5 * time.Millisecond)
	}
	for i, b := range rec.since(from) {
		if one := b.Products["one"]; one.Status != domain.StatusOperational || !one.DataComplete || one.CheckedAt.Components == nil {
			t.Fatalf("build %d during the reload: one = %v, complete %v, checked %v; want the last good data", i, one.Status, one.DataComplete, one.CheckedAt.Components)
		}
	}
	close(slow.gate)
	if err := <-applied; err != nil {
		t.Fatal(err)
	}
	if got := rec.last().Products["one"].Status; got != domain.StatusDegraded {
		t.Fatalf("after the new binding answered: one = %v, want degraded from it", got)
	}
}

// TestApplyKeepsLastGoodDataWhenTheNewBindingFails: a new binding that
// fails leaves the last good data in place until it goes stale, as for a
// source that stops answering.
func TestApplyKeepsLastGoodDataWhenTheNewBindingFails(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	rec := &recorder{}
	var now atomic.Pointer[time.Time]
	now.Store(&t0)
	clock := func() time.Time { return *now.Load() }
	a, err := New(slowConfig(), bindings, Options{Publish: rec.publish, Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	a.RefreshAll(context.Background())
	later := t0.Add(time.Minute)
	now.Store(&later)
	bindings["b/s1"] = Binding{Source: &fakeSource{fail: true}, Fingerprint: "b/s1@v2"}
	if err := a.Apply(context.Background(), slowConfig(), bindings); err != nil {
		t.Fatal(err)
	}
	one := rec.last().Products["one"]
	if one.Status != domain.StatusOperational || one.CheckedAt.Components == nil || !one.CheckedAt.Components.Equal(t0) {
		t.Fatalf("after a failed first poll: one = %v, checked %v; want the data fetched at %v", one.Status, one.CheckedAt.Components, t0)
	}
	if a.succeeded("b/s1", KindComponents) {
		t.Fatal("inherited data must not count as the new binding's success, or its loop would not retry soon")
	}
	stale := t0.Add(4 * time.Hour) // slowConfig polls hourly: three intervals is the budget
	now.Store(&stale)
	a.Rebuild()
	if got := rec.last().Products["one"].Status; got != domain.StatusUnknown {
		t.Fatalf("past the budget: one = %v, want unknown", got)
	}
}

func TestApplyPollingChangeRestartsLoopsAndKeepsData(t *testing.T) {
	t.Parallel()
	bindings, raw := fakes()
	a, rec := startRunning(t, slowConfig(), bindings)
	before := raw["b/s2"].callCount()
	if err := a.Apply(context.Background(), testConfig(), bindings); err != nil {
		t.Fatal(err)
	}
	if got := rec.last().Products["two"].Status; got != domain.StatusOperational {
		t.Fatalf("data must survive a polling change; got %v", got)
	}
	for deadline := time.Now().Add(5 * time.Second); raw["b/s2"].callCount() < before+6; {
		if time.Now().After(deadline) {
			t.Fatalf("loops did not restart on the new 20ms interval: %d calls", raw["b/s2"].callCount())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestApplyRejectsMissingBindingAndKeepsServing(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	a, rec := startRunning(t, slowConfig(), bindings)
	delete(bindings, "b/s3")
	if err := a.Apply(context.Background(), slowConfig(), bindings); err == nil {
		t.Fatal("expected an error for a product without a source")
	}
	if got := rec.last().Products["two"].Status; got != domain.StatusOperational {
		t.Fatalf("a rejected Apply must leave the running catalogue alone; got %v", got)
	}
}

// gatedSource blocks Components until released, to race a poll with Apply.
type gatedSource struct {
	fakeSource
	gate chan struct{}
}

func (g *gatedSource) Components(ctx context.Context) (source.Components, error) {
	<-g.gate
	return g.fakeSource.Components(ctx)
}

func TestPollFromReplacedSourceIsDiscarded(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	old := &gatedSource{fakeSource: fakeSource{components: source.Components{"us": {group(domain.StatusOutage)}}}, gate: make(chan struct{})}
	bindings["b/s1"] = Binding{Source: old, Fingerprint: "old"}
	rec := &recorder{}
	cfg := slowConfig()
	a, err := New(cfg, bindings, Options{Publish: rec.publish})
	if err != nil {
		t.Fatal(err)
	}
	polled := make(chan struct{})
	go func() {
		_ = a.poll(context.Background(), "b/s1", KindComponents)
		close(polled)
	}()
	time.Sleep(20 * time.Millisecond)
	bindings["b/s1"] = Binding{Source: &fakeSource{components: healthy("us", "eu")}, Fingerprint: "new"}
	if err := a.Apply(context.Background(), cfg, bindings); err != nil {
		t.Fatal(err)
	}
	close(old.gate)
	<-polled
	a.Rebuild()
	if got := rec.last().Products["one"].Status; got != domain.StatusOperational {
		t.Fatalf("status = %v: a late answer from the replaced source overwrote the new one", got)
	}
}

func TestSourceObserverFollowsBindings(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	rec := &sourceRecorder{}
	now := t0
	a, err := New(slowConfig(), bindings, Options{Publish: rec.publish, Observer: rec, Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.take(); !slices.Equal(got, []string{"bound b/s1 12:00:00 12:00:00 12:00:00", "bound b/s2 12:00:00 12:00:00 12:00:00", "bound b/s3 12:00:00 12:00:00 12:00:00"}) {
		t.Fatalf("at New: %v", got)
	}

	now = t0.Add(time.Minute)
	next := slowConfig()
	next.Products = []config.Product{next.Products[0], {ID: "three", Name: "Three", Sources: []config.SourceRef{
		{Backend: "b", Cloud: "s2", Regions: []config.RegionRef{{Key: "cp", ID: "cp", Name: "CP"}}},
		{Backend: "b", Cloud: "s4", Regions: []config.RegionRef{{Key: "ap", ID: "ap", Name: "AP"}}},
	}}}
	err = a.Apply(context.Background(), next, map[string]Binding{
		"b/s1": bindings["b/s1"],
		"b/s2": {Source: &fakeSource{components: healthy("cp")}, Fingerprint: "b/s2@v2"},
		"b/s4": {Source: &fakeSource{components: healthy("ap")}, Fingerprint: "b/s4@v1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.take(); !slices.Equal(got, []string{"removed b/s3", "bound b/s2 12:01:00 12:01:00 12:01:00", "bound b/s4 12:01:00 12:01:00 12:01:00"}) {
		t.Fatalf("at Apply: %v; want the removed source dropped, the changed and the new one bound, the unchanged one left alone", got)
	}
}

// TestRebindReportsTheInheritedFetchTimes: a source whose definition
// changes keeps its data until the new binding answers, so its last success
// is still that data's fetch time, per kind; only a kind without data
// starts at the rebind. Otherwise StatusdUpstreamFailing would resolve at
// every such reload while the page still shows the old data as stale.
func TestRebindReportsTheInheritedFetchTimes(t *testing.T) {
	t.Parallel()
	bindings, raw := fakes()
	raw["b/s2"].set(func(f *fakeSource) { f.fail = true })
	rec := &sourceRecorder{}
	now := t0
	a, err := New(slowConfig(), bindings, Options{Publish: rec.publish, Observer: rec, Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	a.RefreshAll(context.Background())
	a.mu.Lock()
	s3 := a.state["b/s3"]
	s3.uptime = fetched[source.Uptime]{}
	a.state["b/s3"] = s3
	a.mu.Unlock()
	rec.take()

	now = t0.Add(5 * time.Minute)
	changed := map[string]Binding{}
	for key, b := range bindings {
		changed[key] = Binding{Source: b.Source, Fingerprint: key + "@v2"}
	}
	for _, f := range raw {
		f.set(func(f *fakeSource) { f.fail = true })
	}
	if err := a.Apply(context.Background(), slowConfig(), changed); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"bound b/s1 12:00:00 12:00:00 12:00:00",
		"bound b/s2 12:05:00 12:05:00 12:05:00",
		"bound b/s3 12:00:00 12:05:00 12:00:00",
	}
	if got := rec.take(); !slices.Equal(got, want) {
		t.Fatalf("at Apply: %v, want %v (components, uptime, incidents)", got, want)
	}
}

func TestNoTelemetryFromAReplacedBinding(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	rec := &sourceRecorder{}
	a, err := New(testConfig(), bindings, Options{Publish: rec.publish, Observer: rec})
	if err != nil {
		t.Fatal(err)
	}
	a.report("b/s1", Binding{Fingerprint: "b/s1@old"}, KindComponents, time.Millisecond, nil)
	a.report("b/gone", Binding{Fingerprint: "b/gone@v1"}, KindComponents, time.Millisecond, nil)
	a.report("b/s1", bindings["b/s1"], KindComponents, time.Millisecond, nil)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if !slices.Equal(rec.fetched, []string{"b/s1"}) {
		t.Fatalf("FetchDone calls = %v, want only the current binding's", rec.fetched)
	}
}

// stuckSource answers components only when its context ends, with the
// context's error wrapped as an HTTP client wraps it. It closes entered
// when the call starts.
type stuckSource struct {
	fakeSource
	entered chan struct{}
}

func (s *stuckSource) Components(ctx context.Context) (source.Components, error) {
	close(s.entered)
	<-ctx.Done()
	return nil, fmt.Errorf("GET monitors: %w", ctx.Err())
}

// syncBuffer collects log output from concurrent writers.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestCancelledPollIsNotAFailure: a reload or a shutdown cancels the polls
// in flight. That is not an upstream failure, so it is neither counted nor
// logged; a request that times out still is.
func TestCancelledPollIsNotAFailure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		cancel bool
		want   int64
	}{
		{"cancelled in flight", true, 0},
		{"timed out", false, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			bindings, _ := fakes()
			stuck := &stuckSource{entered: make(chan struct{})}
			bindings["b/s1"] = Binding{Source: stuck, Fingerprint: "b/s1@v1"}
			var logs syncBuffer
			rec := &recorder{}
			a, err := New(testConfig(), bindings, Options{
				Publish: rec.publish, Observer: rec, Logger: slog.New(slog.NewTextHandler(&logs, nil)),
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tt.cancel {
				go func() {
					<-stuck.entered
					cancel()
				}()
			}
			if err := a.poll(ctx, "b/s1", KindComponents); err == nil {
				t.Fatal("poll succeeded; want the context's error")
			}
			if got := rec.errs.Load(); got != tt.want {
				t.Errorf("failed fetches reported = %d, want %d", got, tt.want)
			}
			if logged := strings.Contains(logs.String(), "upstream fetch failed"); logged != (tt.want > 0) {
				t.Errorf("warning logged = %v, want %v:\n%s", logged, tt.want > 0, logs.String())
			}
		})
	}
}

// TestBuildAfterTheContextEndsIsSkipped: a poll loop's build that waits
// for the one in progress is skipped once the loop's context ends, so a
// shutdown is not held by queued builds; Rebuild still publishes.
func TestBuildAfterTheContextEndsIsSkipped(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	rec := &recorder{}
	a, err := New(testConfig(), bindings, Options{Publish: rec.publish, Observer: rec})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.buildMu.Lock()
	queued := make(chan struct{})
	go func() {
		a.rebuild(ctx.Done())
		close(queued)
	}()
	cancel()
	a.buildMu.Unlock()
	<-queued
	if got := rec.pubs.Load(); got != 0 {
		t.Fatalf("%d builds published after the context ended, want none", got)
	}
	a.Rebuild()
	if got := rec.pubs.Load(); got != 1 {
		t.Fatalf("%d builds published by Rebuild, want 1", got)
	}
}

// productRecorder also implements the optional ProductObserver.
type productRecorder struct {
	recorder
	mu     sync.Mutex
	events []string
}

func (r *productRecorder) ProductStatus(id string, status domain.Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, id+" "+status.String())
}

func (r *productRecorder) ProductRemoved(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, "removed "+id)
}

func (r *productRecorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events
	r.events = nil
	return out
}

// TestProductStatusChangesAreLoggedAndObserved: a product's first published
// status and every change are logged at info and told to the observer; an
// unchanged status is not, and a removed product is reported once.
func TestProductStatusChangesAreLoggedAndObserved(t *testing.T) {
	t.Parallel()
	bindings, raw := fakes()
	rec := &productRecorder{}
	var logs syncBuffer
	a, err := New(slowConfig(), bindings, Options{
		Publish: rec.publish, Observer: rec, Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	onlyOne := slowConfig()
	onlyOne.Products = onlyOne.Products[:1]
	steps := []struct {
		name   string
		act    func()
		want   []string
		logged []string
	}{
		{
			"first build", func() { a.RefreshAll(context.Background()) },
			[]string{"one operational", "two operational"},
			[]string{"level=INFO msg=\"product status changed\" product=one to=operational", "product=two to=operational"},
		},
		{"nothing changed", func() { a.RefreshAll(context.Background()) }, nil, nil},
		{"one degrades", func() {
			raw["b/s1"].set(func(f *fakeSource) {
				f.components = source.Components{"us": {group(domain.StatusDegraded)}, "eu": {group(domain.StatusOperational)}}
			})
			a.RefreshAll(context.Background())
		}, []string{"one degraded"}, []string{"product=one from=operational to=degraded"}},
		{"two removed", func() {
			if err := a.Apply(context.Background(), onlyOne, map[string]Binding{"b/s1": bindings["b/s1"]}); err != nil {
				t.Fatal(err)
			}
		}, []string{"removed two"}, nil},
	}
	for _, step := range steps {
		before := strings.Count(logs.String(), "product status changed")
		step.act()
		if got := rec.take(); !slices.Equal(got, step.want) {
			t.Errorf("%s: observed %v, want %v", step.name, got, step.want)
		}
		all := logs.String()
		if got := strings.Count(all, "product status changed") - before; got != len(step.logged) {
			t.Errorf("%s: %d status lines logged, want %d:\n%s", step.name, got, len(step.logged), all)
		}
		for _, line := range step.logged {
			if !strings.Contains(all, line) {
				t.Errorf("%s: log has no %q:\n%s", step.name, line, all)
			}
		}
	}
}

// TestFailedPublishIsNotObserved: a build the publisher rejects was not
// published, so neither the snapshot-published telemetry nor the product
// statuses move; the next build that is published reports both.
func TestFailedPublishIsNotObserved(t *testing.T) {
	t.Parallel()
	bindings, _ := fakes()
	rec := &productRecorder{}
	var failing atomic.Bool
	failing.Store(true)
	publish := func(b Built) error {
		if failing.Load() {
			return errUpstream
		}
		return rec.publish(b)
	}
	a, err := New(slowConfig(), bindings, Options{Publish: publish, Observer: rec})
	if err != nil {
		t.Fatal(err)
	}
	a.RefreshAll(context.Background())
	if pubs, events := rec.pubs.Load(), rec.take(); pubs != 0 || len(events) != 0 {
		t.Fatalf("after a failed publish: Published called %d times, product events %v; want none", pubs, events)
	}
	failing.Store(false)
	a.Rebuild()
	if pubs, events := rec.pubs.Load(), rec.take(); pubs != 1 || !slices.Equal(events, []string{"one operational", "two operational"}) {
		t.Fatalf("after a published build: Published called %d times, product events %v; want 1 and both products", pubs, events)
	}
}

// dataRecorder implements SourceObserver and DataObserver and records their
// calls in order.
type dataRecorder struct {
	recorder
	mu     sync.Mutex
	events []string
}

func (r *dataRecorder) add(event string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *dataRecorder) SourceBound(string, map[Kind]time.Time) {}
func (r *dataRecorder) SourceRemoved(key string)               { r.add("removed " + key) }

func (r *dataRecorder) ProductData(id string, complete bool, sources []string) {
	r.add(fmt.Sprintf("product %s complete=%v sources=%v", id, complete, sources))
}

func (r *dataRecorder) SourceRegionKeys(key string, missing, unmatched int) {
	r.add(fmt.Sprintf("keys %s missing=%d unmatched=%d", key, missing, unmatched))
}

func (r *dataRecorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events
	r.events = nil
	return out
}

// TestRegionKeyDriftIsReportedOncePerChange: a source whose answer lacks a
// configured region key, or holds one no product configures, is logged at
// warn and reported to a DataObserver once per change, with the product's
// data_complete; a source that matches again is logged at info. A removed
// source gets no report after its removal.
func TestRegionKeyDriftIsReportedOncePerChange(t *testing.T) {
	t.Parallel()
	bindings, raw := fakes()
	rec := &dataRecorder{}
	var logs syncBuffer
	a, err := New(slowConfig(), bindings, Options{Publish: rec.publish, Observer: rec, Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	if err != nil {
		t.Fatal(err)
	}
	renamed := source.Components{"us": {group(domain.StatusOperational)}, "europe": {group(domain.StatusOperational)}}
	onlyOne := slowConfig()
	onlyOne.Products = onlyOne.Products[:1]
	steps := []struct {
		name   string
		act    func()
		want   []string
		logged string
	}{
		{"first build", func() { a.RefreshAll(context.Background()) }, []string{
			"product one complete=true sources=[b/s1]", "product two complete=true sources=[b/s2 b/s3]",
			"keys b/s1 missing=0 unmatched=0", "keys b/s2 missing=0 unmatched=0", "keys b/s3 missing=0 unmatched=0",
		}, ""},
		{"unchanged", func() { a.RefreshAll(context.Background()) }, nil, ""},
		{
			"eu renamed europe", func() {
				raw["b/s1"].set(func(f *fakeSource) { f.components = renamed })
				a.RefreshAll(context.Background())
			},
			[]string{"product one complete=false sources=[b/s1]", "keys b/s1 missing=1 unmatched=1"},
			`level=WARN msg="upstream region keys differ from the configuration; check the region keys in the configuration" source=b/s1 missing=[eu] unmatched=[europe]`,
		},
		{"still renamed", func() { a.RefreshAll(context.Background()) }, nil, ""},
		{
			"named again", func() {
				raw["b/s1"].set(func(f *fakeSource) { f.components = healthy("us", "eu") })
				a.RefreshAll(context.Background())
			},
			[]string{"product one complete=true sources=[b/s1]", "keys b/s1 missing=0 unmatched=0"},
			`level=INFO msg="upstream region keys match the configuration again" source=b/s1`,
		},
		{"two removed", func() {
			if err := a.Apply(context.Background(), onlyOne, map[string]Binding{"b/s1": bindings["b/s1"]}); err != nil {
				t.Fatal(err)
			}
		}, []string{"removed b/s2", "removed b/s3"}, ""},
	}
	for _, step := range steps {
		before := logs.String()
		step.act()
		if got := rec.take(); !slices.Equal(slices.Sorted(slices.Values(got)), slices.Sorted(slices.Values(step.want))) {
			t.Errorf("%s: observed %q, want %q", step.name, got, step.want)
		}
		added := strings.TrimPrefix(logs.String(), before)
		if count := strings.Count(added, "upstream region keys"); (step.logged == "") != (count == 0) || count > 1 || !strings.Contains(added, step.logged) {
			t.Errorf("%s: logged %q, want one line with %q", step.name, added, step.logged)
		}
	}
}
