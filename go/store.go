// go/store.go — the forge's in-memory store, ported from store.ts: repos, branches, commits,
// issues, labels, pulls. Determinism: every id/number comes from a counter; timestamps are
// logical (LC); no wall clock, no randomness anywhere in state.
package main

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

var lc int64 = 1_000_000_000 // logical clock: monotonic counter

// LC advances the logical clock (call under the dispatch mutex).
func LC() int64 {
	lc++
	return lc
}

var reqId int64

// RequestID returns a deterministic request id shaped like GitHub's hex groups.
func RequestID() string {
	reqId++
	n := strings.ToUpper(hex.EncodeToString([]byte(strconv.FormatInt(reqId, 10))))
	for len(n) < 22 {
		n += "0"
	}
	return fmt.Sprintf("RU:%s:%s:%s:%s:%04d", n[0:4], n[4:10], n[10:16], n[16:22], reqId%9999)
}

type Comment struct {
	ID   int64
	Body string
	LC   int64
}

type Issue struct {
	Number    int
	Title     string
	Body      string
	State     string // "open" | "closed"
	Labels    []string
	Comments  []Comment
	CreatedAt int64
	UpdatedAt int64
}

type Label struct {
	Name  string
	Color string
}

type PullFile struct {
	Path        string
	HeadContent string
	BaseContent string
}

type Pull struct {
	Number         int
	Title          string
	Body           string
	State          string // "open" | "closed"
	Merged         bool
	HeadRef        string
	HeadSha        string
	BaseRef        string
	BaseSha        string
	MergeCommitSha string
	MergedAt       *int64
	CreatedAt      int64
	Files          []PullFile
}

type CommitNode struct {
	Sha     string
	Message string
	Tree    map[string]string // flat path -> blob sha
	Parents []string
	LC      int64
}

type Repo struct {
	ID            int64
	Owner         string
	Name          string
	Private       bool
	Description   string
	DefaultBranch string

	Branches    map[string]string // name -> commit sha
	Commits     map[string]*CommitNode
	commitOrder []string // insertion order for deterministic iteration
	Issues      map[int]*Issue
	issueOrder  []int
	IssueSeq    int
	Labels      map[string]*Label
	labelOrder  []string
	Pulls       map[int]*Pull
	pullOrder   []int
	PullSeq     int
	CreatedAt   int64

	// git-transport side state (mirrors the TS side-channel maps)
	BlobStore      map[string]string // blob sha -> utf8 content
	CommitRaws     map[string][]byte // pushed commit exact bytes
	TreeRaws       map[string][]byte // pushed tree exact bytes
	Tags           map[string]string // tag name -> oid
	tagOrder       []string
	TagObjects     map[string]*GitObj // annotated tag oid -> object
	RefGen         int                // bumped on every ref change
	refCacheGen    int                // generation the RefListCache was built at
	RefListCache   []RefEntry
	PackCache      map[string][]byte // fetch answer cache, cleared on ref change
	IssueBodyCache map[int]issueBodyCacheEntry
}

type issueBodyCacheEntry struct {
	Ver  int64
	Body string
}

type Store struct {
	Repos     map[string]*Repo // key: strings.ToLower(owner + "/" + name)
	repoOrder []string         // insertion order
	UserSeq   int64
	ShaSeq    int64
}

var store = &Store{Repos: make(map[string]*Repo)}

func repoKey(owner, name string) string { return strings.ToLower(owner + "/" + name) }

// GetRepoAnyOwner finds a repo by name alone (single-tenant: owner binds on first read).
func GetRepoAnyOwner(name string) *Repo {
	for _, k := range store.repoOrder {
		if store.Repos[k].Name == name {
			return store.Repos[k]
		}
	}
	return nil
}

// GetRepo looks a repo up by owner+name (owner may be "" for the create-time key).
func GetRepo(owner, name string) *Repo { return store.Repos[repoKey(owner, name)] }

// RekeyRepo moves a repo from its create-time key (”/name) to owner/name.
func RekeyRepo(repo *Repo, owner, name string) {
	delete(store.Repos, repoKey("", name))
	store.Repos[repoKey(owner, name)] = repo
	// fix the insertion order entry (it was stored under ''/name)
	key := repoKey(owner, name)
	for i, k := range store.repoOrder {
		if k == repoKey("", name) || store.Repos[k] == repo {
			store.repoOrder[i] = key
			break
		}
	}
}

func CreateRepo(owner, name string, isPrivate bool, description string) *Repo {
	repo := &Repo{
		ID:             store.UserSeq + 1,
		Owner:          owner,
		Name:           name,
		Private:        isPrivate,
		Description:    description,
		DefaultBranch:  "main",
		Branches:       make(map[string]string),
		Commits:        make(map[string]*CommitNode),
		Issues:         make(map[int]*Issue),
		Labels:         make(map[string]*Label),
		Pulls:          make(map[int]*Pull),
		CreatedAt:      LC(),
		BlobStore:      make(map[string]string),
		CommitRaws:     make(map[string][]byte),
		TreeRaws:       make(map[string][]byte),
		Tags:           make(map[string]string),
		TagObjects:     make(map[string]*GitObj),
		PackCache:      make(map[string][]byte),
		IssueBodyCache: make(map[int]issueBodyCacheEntry),
	}
	store.UserSeq++
	key := repoKey(owner, name)
	if _, exists := store.Repos[key]; !exists {
		store.repoOrder = append(store.repoOrder, key)
	}
	store.Repos[key] = repo
	return repo
}

func DeleteRepo(owner, name string) {
	key := repoKey(owner, name)
	delete(store.Repos, key)
	for i, k := range store.repoOrder {
		if k == key {
			store.repoOrder = append(store.repoOrder[:i], store.repoOrder[i+1:]...)
			break
		}
	}
}

// ListRepos returns every repo sorted by id (owner ” means all, single-tenant).
func ListRepos() []*Repo {
	out := make([]*Repo, 0, len(store.repoOrder))
	for _, k := range store.repoOrder {
		out = append(out, store.Repos[k])
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// IssueList returns the repo's issues in insertion order.
func (r *Repo) IssueList() []*Issue {
	out := make([]*Issue, 0, len(r.issueOrder))
	for _, n := range r.issueOrder {
		if i, ok := r.Issues[n]; ok {
			out = append(out, i)
		}
	}
	return out
}

func (r *Repo) PutIssue(i *Issue) {
	if _, ok := r.Issues[i.Number]; !ok {
		r.issueOrder = append(r.issueOrder, i.Number)
	}
	r.Issues[i.Number] = i
}

// PullList returns the repo's pulls in insertion order.
func (r *Repo) PullList() []*Pull {
	out := make([]*Pull, 0, len(r.pullOrder))
	for _, n := range r.pullOrder {
		if p, ok := r.Pulls[n]; ok {
			out = append(out, p)
		}
	}
	return out
}

func (r *Repo) PutPull(p *Pull) {
	if _, ok := r.Pulls[p.Number]; !ok {
		r.pullOrder = append(r.pullOrder, p.Number)
	}
	r.Pulls[p.Number] = p
}

// BranchNames returns branch names sorted (deterministic ref order).
func (r *Repo) BranchNames() []string {
	names := make([]string, 0, len(r.Branches))
	for n := range r.Branches {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// TagNames returns tag names sorted, with their oids.
func (r *Repo) TagPairs() [][2]string {
	out := make([][2]string, 0, len(r.Tags))
	names := make([]string, 0, len(r.Tags))
	for n := range r.Tags {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		out = append(out, [2]string{n, r.Tags[n]})
	}
	return out
}

// PutCommit stores a commit node keeping deterministic iteration.
func (r *Repo) PutCommit(c *CommitNode) {
	if _, ok := r.Commits[c.Sha]; !ok {
		r.commitOrder = append(r.commitOrder, c.Sha)
	}
	r.Commits[c.Sha] = c
}

// NewSha returns a deterministic 40-hex sha from a seed + counter.
func NewSha(seed string) string {
	store.ShaSeq++
	h := sha1.New()
	h.Write([]byte(seed))
	h.Write([]byte(strconv.FormatInt(store.ShaSeq, 10)))
	return hex.EncodeToString(h.Sum(nil))
}

// NewNodeID returns a GitHub-ish base64 node id.
func NewNodeID(kind string, n int) string {
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%s:%d", kind, n)))
}

// isoFromLc renders a deterministic ISO date from the logical clock: base epoch + v seconds,
// formatted like JS toISOString() with the ".000Z" fraction stripped (LC values are whole
// seconds, so the fraction is always .000).
func isoFromLc(v int64) string {
	const base = int64(1760000000)
	return time.Unix(base+v, 0).UTC().Format("2006-01-02T15:04:05Z")
}

// hashStr is the TS hashStr (31-based) used for label ids; JS |0 wraps to int32.
func hashStr(s string) int {
	var h int32
	for _, c := range s {
		h = int32(int64(h)*31 + int64(c)) // wrap like JS |0
	}
	if h < 0 {
		h = -h
	}
	return int(h)
}
