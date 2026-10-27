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
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/wso2/wso2-cloud-status/backend/go/internal/config"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/domain"
	"github.com/wso2/wso2-cloud-status/backend/go/internal/source"
)

// fetched is one kind of data from one source and when it last succeeded.
// Stored data is never mutated, so readers may share it.
type fetched[T any] struct {
	data T
	at   time.Time
	// inherited is true for data a replaced binding fetched; the current
	// binding has not answered for this kind yet.
	inherited bool
}

func (f fetched[T]) ok() bool { return !f.at.IsZero() }

// sourceState is the last good data from one source.
type sourceState struct {
	components fetched[source.Components]
	uptime     fetched[source.Uptime]
	incidents  fetched[source.Incidents]
}

// Built is one consistent set of API views.
type Built struct {
	Summary   Summary
	Products  map[string]ProductDetail
	Incidents Incidents
	// Ready is true once at least one source has answered for components.
	Ready bool
	// RegionKeys compares, per source that has answered for components, the
	// region keys its last answer holds with those the configuration names
	// for it (across every product that reads it).
	RegionKeys map[string]RegionKeys
	// held is each product's checked_at as published, for the next build
	// (buildParams.held).
	held map[string]heldCheck
}

// heldCheck is a product's published checked_at and what it was derived
// under: the minute of generated_at, the product's stale flags, which kinds
// were null, and the product's sources.
type heldCheck struct {
	minute  time.Time
	stale   Stale
	nulls   [3]bool
	sources string
	value   CheckedAt
}

// hold returns prev, the checked_at already published, while cur was derived
// in the same minute, with the same stale flags, the same null kinds and the
// same sources; otherwise cur. Fetches land at any second, so without this
// every source's first fetch of a minute would change the body again;
// checked_at instead moves forward once a minute, together with
// generated_at, and at once when the product's freshness changes.
func hold(prev, cur heldCheck) heldCheck {
	if prev.minute.Equal(cur.minute) && prev.stale == cur.stale && prev.nulls == cur.nulls && prev.sources == cur.sources {
		return prev
	}
	return cur
}

// RegionKeys lists, in key order, the configured region keys a source's
// last answer lacks (Missing: those regions read unknown) and the keys it
// holds that no product configures (Unmatched: shown under derived ids).
// Either one non-empty usually means the upstream renamed a region.
type RegionKeys struct {
	Missing   []string
	Unmatched []string
}

type buildParams struct {
	products []config.Product
	state    map[string]sourceState
	now      time.Time
	stale    staleness
	days     int
	// held is the previous build's Built.held; nil derives every checked_at
	// afresh.
	held map[string]heldCheck
}

// staleness is how old each kind of data may be before it is stale:
// polling.stale_after, or three of that kind's intervals when that is
// longer, so a slow kind is not stale between two polls that succeed.
type staleness struct {
	components, uptime, incidents time.Duration
}

func stalenessOf(p config.Polling) staleness {
	limit := func(every time.Duration) time.Duration { return max(p.StaleAfter, 3*every) }
	return staleness{
		components: limit(p.ComponentsInterval),
		uptime:     limit(p.UptimeInterval),
		incidents:  limit(p.IncidentsInterval),
	}
}

// SourceKey identifies a source binding.
func SourceKey(ref config.SourceRef) string {
	return ref.Backend + "/" + ref.Cloud
}

// minuteOf is t in UTC, floored to the minute: the granularity of
// generated_at and checked_at.
func minuteOf(t time.Time) time.Time {
	return t.UTC().Truncate(time.Minute)
}

// minuteOrNil is minuteOf(t), or nil for a zero t.
func minuteOrNil(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	m := minuteOf(t)
	return &m
}

// build derives every view from the state. It is pure: same inputs, same
// output.
func build(p buildParams) Built {
	generated := minuteOf(p.now)
	b := Built{
		Summary:   Summary{GeneratedAt: generated},
		Products:  make(map[string]ProductDetail, len(p.products)),
		Incidents: Incidents{GeneratedAt: generated},
		held:      make(map[string]heldCheck, len(p.products)),
	}
	all := []domain.Incident{}
	statuses := make([]domain.Status, 0, len(p.products))
	configured := configuredKeys(p.products)
	for _, prod := range p.products {
		pb := buildProduct(p, prod, configured)
		detail := pb.detail
		detail.GeneratedAt = generated
		held := hold(p.held[prod.ID], heldCheck{
			minute: generated, stale: detail.Stale, nulls: nullKinds(detail.CheckedAt),
			sources: sourcesOf(prod), value: detail.CheckedAt,
		})
		detail.CheckedAt, b.held[prod.ID] = held.value, held
		b.Products[prod.ID] = detail
		b.Summary.Products = append(b.Summary.Products, detail.ProductSummary)
		b.Incidents.Products = append(b.Incidents.Products, IncidentCoverage{
			ID: prod.ID, Name: prod.Name, CoveredFrom: pb.coveredFrom,
			CheckedAt: detail.CheckedAt.Incidents, Stale: detail.Stale.Incidents,
		})
		statuses = append(statuses, detail.Status)
		all = append(all, pb.allIncidents...)
	}
	domain.SortIncidents(all)
	b.Summary.DataComplete = allComplete(b.Summary.Products)
	b.Summary.Status = failClosed(statuses, b.Summary.DataComplete)
	b.Summary.ActiveIncidents = filter(all, func(i domain.Incident) bool { return i.Active() })
	b.Incidents.Incidents = all
	b.Ready = ready(p.state)
	b.RegionKeys = regionKeys(p.state, configured)
	return b
}

// overlaps reports whether the incident is active or touches the history
// window that starts at cutoff, as domain.DailyHistory counts it: it started
// in the window, or ended after the window began. A product's own route lists
// only these, so every incident a history day lists is in its list, and
// nothing older is; the incident list keeps every incident.
func overlaps(i domain.Incident, cutoff time.Time) bool {
	return i.Active() || !i.StartedAt.Before(cutoff) || i.ResolvedAt.After(cutoff)
}

// nullKinds tells which kinds of c are null.
func nullKinds(c CheckedAt) [3]bool {
	return [3]bool{c.Components == nil, c.Incidents == nil, c.Uptime == nil}
}

// sourcesOf identifies the product's sources, in order.
func sourcesOf(prod config.Product) string {
	keys := make([]string, len(prod.Sources))
	for i, ref := range prod.Sources {
		keys[i] = SourceKey(ref)
	}
	return strings.Join(keys, "\x00")
}

// regionKeys compares each answering source's region keys with the
// configured ones.
func regionKeys(state map[string]sourceState, configured map[string]map[string]bool) map[string]RegionKeys {
	out := map[string]RegionKeys{}
	for key, names := range configured {
		if st := state[key]; st.components.ok() {
			out[key] = RegionKeys{
				Missing:   absent(slices.Sorted(maps.Keys(names)), st.components.data),
				Unmatched: absent(slices.Sorted(maps.Keys(st.components.data)), names),
			}
		}
	}
	return out
}

// configuredKeys is, per source, the region keys every product that reads it
// names.
func configuredKeys(products []config.Product) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for _, prod := range products {
		for _, ref := range prod.Sources {
			key := SourceKey(ref)
			if out[key] == nil {
				out[key] = map[string]bool{}
			}
			for _, rr := range ref.Regions {
				out[key][rr.Key] = true
			}
		}
	}
	return out
}

// absent returns the names that are not keys of in, in order.
func absent[V any](names []string, in map[string]V) []string {
	var out []string
	for _, name := range names {
		if _, ok := in[name]; !ok {
			out = append(out, name)
		}
	}
	return out
}

// failClosed rolls statuses up for the overall status and each location,
// computed here once and shown by the page as is: unknown when data is
// missing (complete is false) and no problem (maintenance or worse) is
// known, otherwise the most severe known status. A known problem leads even
// over missing data.
func failClosed(statuses []domain.Status, complete bool) domain.Status {
	worst := domain.Worst(statuses...)
	if !complete && worst <= domain.StatusOperational {
		return domain.StatusUnknown
	}
	return worst
}

// allComplete reports whether there are products and every one of them has
// complete data and a known status.
func allComplete(products []ProductSummary) bool {
	for _, p := range products {
		if !p.DataComplete || !p.Status.Known() {
			return false
		}
	}
	return len(products) > 0
}

// productBuild is one product's views and what the incident list needs
// from it: every incident its sources keep, and from when that list is
// complete (nil while a source has never answered for incidents).
type productBuild struct {
	detail       ProductDetail
	allIncidents []domain.Incident
	coveredFrom  *time.Time
}

// buildProduct derives one product's views. configured is configuredKeys of
// the whole configuration.
func buildProduct(p buildParams, prod config.Product, configured map[string]map[string]bool) productBuild {
	count := 0
	for _, ref := range prod.Sources {
		count += len(ref.Regions)
	}
	regions := make([]RegionDetail, 0, count)
	unmatched := unmatchedRegions(p, prod, configured)
	for i, ref := range prod.Sources {
		regions = append(regions, buildRegions(p, ref, unmatched[i])...)
	}
	locations := locationsOf(prod, regions)
	regions = byLocation(regions, locations)
	comp := feedOf(p.state, prod.Sources, p.now, p.stale.components, func(st sourceState) time.Time { return st.components.at })
	inc := feedOf(p.state, prod.Sources, p.now, p.stale.incidents, func(st sourceState) time.Time { return st.incidents.at })
	allIncidents, coverage := productIncidents(p, prod, inc)
	history := domain.DailyHistory(allIncidents, p.days, coverage, p.now)
	domain.RaiseToday(history, worstRegion(regions))
	cutoff := p.now.UTC().Truncate(24*time.Hour).AddDate(0, 0, 1-p.days)
	incidents := filter(allIncidents, func(i domain.Incident) bool { return overlaps(i, cutoff) })
	up := feedOf(p.state, prod.Sources, p.now, p.stale.uptime, func(st sourceState) time.Time { return st.uptime.at })
	statuses := make([]domain.Status, 0, len(regions)+len(incidents))
	summaries := make([]RegionSummary, 0, len(regions))
	affected, complete := 0, len(regions) > 0
	for _, r := range regions {
		statuses = append(statuses, r.Status)
		summaries = append(summaries, RegionSummary{
			ID: r.ID, Location: r.Location, Name: r.Name, Status: r.Status, Uptime: r.Uptime,
		})
		if r.Status > domain.StatusOperational {
			affected++
		}
		complete = complete && regionComplete(r.Region)
	}
	for _, inc := range incidents {
		if inc.Active() {
			statuses = append(statuses, inc.EffectiveImpact())
		}
	}
	detail := ProductDetail{
		ProductSummary: ProductSummary{
			ID: prod.ID, Name: prod.Name, Description: prod.Description,
			Status:          domain.Worst(statuses...),
			AffectedRegions: affected,
			DataComplete:    complete,
			Outdated:        inc.stale || up.stale,
			CheckedAt:       CheckedAt{Components: minuteOrNil(comp.oldest), Incidents: minuteOrNil(inc.oldest), Uptime: minuteOrNil(up.oldest)},
			Stale:           Stale{Components: comp.stale, Incidents: inc.stale, Uptime: up.stale},
			Locations:       locations,
			Regions:         summaries,
			History:         history,
		},
		RegionDetails: regions,
		Incidents:     incidents,
	}
	return productBuild{detail: detail, allIncidents: allIncidents, coveredFrom: coveredFrom(coverage, p.now)}
}

// coveredFrom is the coverage start the incident list publishes: nil when it
// is unknown, or in the future because a source has never answered.
func coveredFrom(coverage domain.Coverage, now time.Time) *time.Time {
	if coverage.From.IsZero() || coverage.From.After(now) {
		return nil
	}
	from := coverage.From.UTC()
	return &from
}

// worstRegion is the most severe known status among the regions, unknown
// when none is known.
func worstRegion(regions []RegionDetail) domain.Status {
	statuses := make([]domain.Status, 0, len(regions))
	for _, r := range regions {
		statuses = append(statuses, r.Status)
	}
	return domain.Worst(statuses...)
}

// feed is one kind of data across some sources: the oldest last successful
// fetch among them (zero while any has never answered), and whether any has
// never answered or answered longer ago than the kind's staleness. Stale
// components show as unknown regions; stale incidents or uptime keep their
// last known data (an open incident still raises the status) and make the
// product outdated.
type feed struct {
	oldest time.Time
	stale  bool
}

// feedOf reads one kind (at returns a source's last success of it, zero for
// never) across the given sources.
func feedOf(state map[string]sourceState, refs []config.SourceRef, now time.Time, limit time.Duration, at func(sourceState) time.Time) feed {
	oldest := oldestOf(state, refs, at)
	return feed{oldest: oldest, stale: oldest.IsZero() || now.Sub(oldest) > limit}
}

// oldestOf is the oldest last success of one kind among the given sources,
// or zero while any of them has never answered for it.
func oldestOf(state map[string]sourceState, refs []config.SourceRef, at func(sourceState) time.Time) time.Time {
	var oldest time.Time
	for _, ref := range refs {
		t := at(state[SourceKey(ref)])
		if t.IsZero() {
			return time.Time{}
		}
		if oldest.IsZero() || t.Before(oldest) {
			oldest = t
		}
	}
	return oldest
}

// regionComplete reports whether the region's status and the status of
// every component in it are known.
func regionComplete(r domain.Region) bool {
	if !r.Status.Known() {
		return false
	}
	for _, g := range r.Groups {
		for _, c := range g.Components {
			if !c.Status.Known() {
				return false
			}
		}
	}
	return true
}

// locationsOf lists the product's locations in the order their first
// region appears in the configuration, each with failClosed over its
// regions' statuses.
func locationsOf(prod config.Product, regions []RegionDetail) []Location {
	out := []Location{}
	index := map[string]int{}
	for _, ref := range prod.Sources {
		for _, rr := range ref.Regions {
			id := rr.LocationID()
			if _, seen := index[id]; id == "" || seen {
				continue
			}
			index[id] = len(out)
			out = append(out, Location{ID: id, Name: rr.Location})
		}
	}
	statuses := make([][]domain.Status, len(out))
	complete := make([]bool, len(out))
	for i := range complete {
		complete[i] = true
	}
	for _, r := range regions {
		if i, ok := index[r.Location]; ok {
			statuses[i] = append(statuses[i], r.Status)
			complete[i] = complete[i] && r.Status.Known()
		}
	}
	for i := range out {
		out[i].Status = failClosed(statuses[i], complete[i])
	}
	return out
}

// byLocation lists each location's regions together, in the locations'
// order and by name within one (control plane before data plane), then the
// regions without a location in their own order.
func byLocation(regions []RegionDetail, locations []Location) []RegionDetail {
	rank := map[string]int{}
	for i, l := range locations {
		rank[l.ID] = i
	}
	out := slices.Clone(regions)
	slices.SortStableFunc(out, func(a, b RegionDetail) int {
		ra, aLocated := rank[a.Location]
		rb, bLocated := rank[b.Location]
		switch {
		case !aLocated || !bLocated:
			return cmp.Compare(boolRank(!aLocated), boolRank(!bLocated))
		case ra != rb:
			return cmp.Compare(ra, rb)
		default:
			return strings.Compare(a.Name, b.Name)
		}
	})
	return out
}

// boolRank sorts false before true.
func boolRank(b bool) int {
	if b {
		return 1
	}
	return 0
}

// buildRegions returns the configured regions in order, then the regions the
// upstream reports that the configuration does not name (unmatched), so a
// new region is never hidden.
func buildRegions(p buildParams, ref config.SourceRef, unmatched []config.RegionRef) []RegionDetail {
	st := p.state[SourceKey(ref)]
	fresh := st.components.ok() && p.now.Sub(st.components.at) <= p.stale.components
	out := make([]RegionDetail, 0, len(ref.Regions)+len(unmatched))
	for _, rr := range ref.Regions {
		out = append(out, buildRegion(st, rr, fresh))
	}
	for _, rr := range unmatched {
		out = append(out, buildRegion(st, rr, fresh))
	}
	return out
}

// unmatchedRegions names, per source of the product, the region keys the
// upstream reports that no product configures for that source (configured,
// from configuredKeys), in key order. A key another product reads from a
// shared source is that product's region, not an unknown one here, as the
// region-key metrics count it. Their IDs
// are non-empty, unique within the product and independent of the order
// keys are seen in: a key's slug ("region" when the key has no letter or
// digit) is its ID unless a configured region or another unmatched key has
// the same slug; then each such key takes the slug plus "-" and the first 8
// hex digits of the SHA-256 of the key. Only the same key reported by two
// sources of one product still collides; later sources then add "-2",
// "-3" and so on.
func unmatchedRegions(p buildParams, prod config.Product, configured map[string]map[string]bool) [][]config.RegionRef {
	reserved := map[string]bool{}
	keys := make([][]string, len(prod.Sources))
	slugs := map[string]int{}
	for i, ref := range prod.Sources {
		for _, rr := range ref.Regions {
			reserved[rr.ID] = true
		}
		known := configured[SourceKey(ref)]
		for _, key := range slices.Sorted(maps.Keys(p.state[SourceKey(ref)].components.data)) {
			if !known[key] {
				keys[i] = append(keys[i], key)
				slugs[regionSlug(key)]++
			}
		}
	}
	taken := maps.Clone(reserved)
	out := make([][]config.RegionRef, len(prod.Sources))
	for i, ks := range keys {
		for _, key := range ks {
			id := regionSlug(key)
			if reserved[id] || slugs[id] > 1 {
				sum := sha256.Sum256([]byte(key))
				id += "-" + hex.EncodeToString(sum[:4])
			}
			id = firstFree(id, taken)
			taken[id] = true
			out[i] = append(out[i], config.RegionRef{Key: key, ID: id, Name: key})
		}
	}
	return out
}

// regionSlug is the key's slug, or "region" when it has no letter or digit.
func regionSlug(key string) string {
	if s := config.Slugify(key); s != "" {
		return s
	}
	return "region"
}

// firstFree returns id, or id with the smallest "-N" suffix (from 2) that
// is not taken.
func firstFree(id string, taken map[string]bool) string {
	candidate := id
	for n := 2; taken[candidate]; n++ {
		candidate = id + "-" + strconv.Itoa(n)
	}
	return candidate
}

func buildRegion(st sourceState, rr config.RegionRef, fresh bool) RegionDetail {
	groups := st.components.data[rr.Key]
	if !fresh {
		groups = unknownGroups(groups)
	}
	uptime := st.uptime.data[rr.Key]
	if groups == nil {
		groups = []domain.Group{}
	}
	if uptime == nil {
		uptime = []domain.Uptime{}
	}
	return RegionDetail{
		Region: domain.Region{
			ID:     rr.ID,
			Name:   rr.Name,
			Status: domain.RegionStatus(groups),
			Uptime: uptime,
			Groups: groups,
		},
		Location: rr.LocationID(),
	}
}

// unknownGroups copies groups with every status unknown: data we cannot vouch
// for keeps its shape but never reads as healthy.
func unknownGroups(groups []domain.Group) []domain.Group {
	out := make([]domain.Group, len(groups))
	for i, g := range groups {
		components := make([]domain.Component, len(g.Components))
		for j, c := range g.Components {
			c.Status = domain.StatusUnknown
			components[j] = c
		}
		out[i] = domain.Group{Name: g.Name, Status: domain.StatusUnknown, Components: components}
	}
	return out
}

// productIncidents merges the incidents of the product's sources that have
// answered, so one silent source does not hide another's open incident. The
// same id from two sources is one incident (the first source's copy), and
// records of one event are listed once (collapseDuplicates). History is
// only as complete as the least complete source. Coverage starts at the latest
// source's coverage start, and while any source has never answered it lies
// in the future, so every day reads unknown. While the incident feed is
// stale it ends at the feed's oldest last success, so the decision that sets
// stale.incidents also ends the history: nothing is known after it. Both are
// derived again at every build, so the days fill in again as soon as the
// source answers.
func productIncidents(p buildParams, prod config.Product, feed feed) ([]domain.Incident, domain.Coverage) {
	incidents := []domain.Incident{}
	var coverage domain.Coverage
	missing := false
	seen := map[string]bool{}
	for _, ref := range prod.Sources {
		st := p.state[SourceKey(ref)]
		if !st.incidents.ok() {
			missing = true
			continue
		}
		if st.incidents.data.CoverageStart.After(coverage.From) {
			coverage.From = st.incidents.data.CoverageStart
		}
		for _, inc := range st.incidents.data.Items {
			if seen[inc.ID] {
				continue
			}
			seen[inc.ID] = true
			inc.ProductID = prod.ID
			incidents = append(incidents, inc)
		}
	}
	if missing {
		coverage.From = p.now.Add(48 * time.Hour)
	}
	if feed.stale {
		coverage.Until = feed.oldest
	}
	return collapseDuplicates(incidents), coverage
}

// collapseWindow is how far apart the starts, and the ends, of two records
// may be for them to be one incident.
const collapseWindow = time.Minute

// incidentKind is what two records must share to be one incident: title,
// impact, and whether they are open or resolved.
type incidentKind struct {
	title    string
	impact   domain.Status
	resolved bool
}

// collapseDuplicates lists records of one product as one incident when they
// are records of one event: they share a kind (incidentKind), and their
// starts, and their ends, are at most collapseWindow apart (two open records
// end together), directly or through other such records. The upstream
// sometimes files one event as several records, apparently one per region,
// created seconds apart, which a reader cannot tell apart. Each set keeps
// its record with the smallest id, with that record's own times, so the
// result depends only on the records: not on their order, nor on which of
// them happens to have the smallest id. incidents must have unique ids; the
// result is sorted (domain.SortIncidents).
func collapseDuplicates(incidents []domain.Incident) []domain.Incident {
	byKind := map[incidentKind][]domain.Incident{}
	for _, inc := range incidents {
		kind := incidentKind{title: inc.Title, impact: inc.Impact, resolved: inc.ResolvedAt != nil}
		byKind[kind] = append(byKind[kind], inc)
	}
	out := make([]domain.Incident, 0, len(incidents))
	for _, records := range byKind {
		out = append(out, oneOfEachEvent(records)...)
	}
	domain.SortIncidents(out)
	return out
}

// oneOfEachEvent returns, for each set of records that sameEvent connects,
// the record with the smallest id. In start order, each record is compared
// only with the later ones that start within collapseWindow of it and are
// not yet in its set, so the cost is a sort plus the pairs that start that
// close together.
func oneOfEachEvent(records []domain.Incident) []domain.Incident {
	order := make([]int, len(records))
	for i := range order {
		order[i] = i
	}
	slices.SortFunc(order, func(i, j int) int { return records[i].StartedAt.Compare(records[j].StartedAt) })
	sets := newDisjointSets(len(records))
	for x, i := range order {
		for _, j := range order[x+1:] {
			if records[j].StartedAt.Sub(records[i].StartedAt) > collapseWindow {
				break
			}
			if sets.find(i) != sets.find(j) && sameEvent(&records[i], &records[j]) {
				sets.union(i, j)
			}
		}
	}
	kept := map[int]domain.Incident{}
	for i, r := range records {
		if k, ok := kept[sets.find(i)]; !ok || r.ID < k.ID {
			kept[sets.find(i)] = r
		}
	}
	return slices.Collect(maps.Values(kept))
}

// disjointSets is a union-find over 0 to n-1, with union by size and path
// halving, so each find or union costs almost constant time.
type disjointSets struct {
	root, size []int
}

func newDisjointSets(n int) disjointSets {
	s := disjointSets{root: make([]int, n), size: make([]int, n)}
	for i := range n {
		s.root[i], s.size[i] = i, 1
	}
	return s
}

func (s disjointSets) find(i int) int {
	for s.root[i] != i {
		s.root[i] = s.root[s.root[i]]
		i = s.root[i]
	}
	return i
}

func (s disjointSets) union(i, j int) {
	a, b := s.find(i), s.find(j)
	if a == b {
		return
	}
	if s.size[a] < s.size[b] {
		a, b = b, a
	}
	s.root[b] = a
	s.size[a] += s.size[b]
}

// sameEvent reports whether two records of one kind start, and end, within
// collapseWindow of each other.
func sameEvent(a, b *domain.Incident) bool {
	if !near(a.StartedAt, b.StartedAt) {
		return false
	}
	if a.ResolvedAt == nil || b.ResolvedAt == nil {
		return a.ResolvedAt == nil && b.ResolvedAt == nil
	}
	return near(*a.ResolvedAt, *b.ResolvedAt)
}

func near(a, b time.Time) bool {
	return a.Sub(b).Abs() <= collapseWindow
}

// ready reports whether at least one source has answered for components.
func ready(state map[string]sourceState) bool {
	for _, st := range state {
		if st.components.ok() {
			return true
		}
	}
	return false
}

func filter(incidents []domain.Incident, keep func(domain.Incident) bool) []domain.Incident {
	out := make([]domain.Incident, 0, len(incidents))
	for _, inc := range incidents {
		if keep(inc) {
			out = append(out, inc)
		}
	}
	return out
}
