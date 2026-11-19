package main

import (
	"testing"
)

// TestCloneCacheHitRate: the clone workload sends the SAME depth-1 fetch 50x per round.
// Instrument: 1 cold build + 49 cache hits. Assert the cache actually serves (hits > 0).
func TestCloneCacheHitRate(t *testing.T) {
	repo := buildBenchRepo(&testing.B{})
	args := []string{"want " + repo.Branches["main"], "deepen 1", "done"}
	handleFetchV2(repo, args) // first: builds + stores the cache entry
	if len(repo.PackCache) != 1 {
		t.Fatalf("PackCache size = %d, want 1 (cache did not store)", len(repo.PackCache))
	}
	before := len(repo.PackCache)
	handleFetchV2(repo, args) // hit
	handleFetchV2(repo, args) // hit
	if len(repo.PackCache) != before {
		t.Fatal("cache churned between identical fetches")
	}
	// a push invalidates:
	repo.Branches["main"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	invalidateRefCaches(repo)
	if len(repo.PackCache) != 0 {
		t.Fatalf("cache survived a ref change: %d entries", len(repo.PackCache))
	}
}

// Benchmarks split the clone cost: cold (pack build + sideband) vs cached (cache lookup + write).
func BenchmarkCloneCold(b *testing.B) {
	repo := buildBenchRepo(b)
	args := []string{"want " + repo.Branches["main"], "deepen 1", "done"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		repo.PackCache = make(map[string][]byte)
		handleFetchV2(repo, args)
	}
}

func BenchmarkCloneCached(b *testing.B) {
	repo := buildBenchRepo(b)
	args := []string{"want " + repo.Branches["main"], "deepen 1", "done"}
	handleFetchV2(repo, args)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		handleFetchV2(repo, args)
	}
}

// BenchAbsorb: the setup-side cost (absorbing the 200-commit history) — outside the timed round
// but inside the budget.
func BenchAbsorb(b *testing.B) {
	for i := 0; i < b.N; i++ {
		buildBenchRepo(b)
	}
}
