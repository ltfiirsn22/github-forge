// go/rest.go — GitHub REST v3 surface for /api/v3, ported from rest.ts (55 checks green there).
// Every reply is JSON with X-GitHub-Request-Id; errors are {message}.
package main

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const viewerFallback = "forge-user"

var ctxOwnerFallback = viewerFallback

func CurrentViewer() string { return ctxOwnerFallback }
func SetViewer(login string) {
	if login != "" {
		ctxOwnerFallback = login
	}
}

var restReqSeq int64

func requestIDHeader() string {
	restReqSeq++
	return fmt.Sprintf("RR:%08d:%08X", restReqSeq, restReqSeq)
}

type restResult struct {
	status  int
	body    []byte // full JSON body (no trailing newline added here)
	headers [][2]string
}

func jsonBody(v any) []byte { return append(mustJSON(v), '\n') }

func sendRest(status int, body any, headers ...[2]string) restResult {
	return restResult{status, jsonBody(body), headers}
}

func msgRest(status int, message string, headers ...[2]string) restResult {
	return sendRest(status, NewOMap().Set("message", message), headers...)
}

// parseJSONBody decodes the request body ("" when none).
func parseJSONBody(body []byte) any {
	if len(body) == 0 {
		return nil
	}
	v, err := parseSimpleJSON(body)
	if err != nil {
		return nil
	}
	return v
}

func bodyMap(body any) *OMap {
	if m, ok := body.(*OMap); ok {
		return m
	}
	return NewOMap()
}

func bStr(m *OMap, key string) string {
	if v, ok := m.Get(key); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func bBool(m *OMap, key string) bool {
	if v, ok := m.Get(key); ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

func bFloat(m *OMap, key string) (float64, bool) {
	if v, ok := m.Get(key); ok {
		if f, ok := v.(float64); ok {
			return f, true
		}
	}
	return 0, false
}

// ownerRepo resolves the repo for /repos/{owner}/{name}: single-tenant bind-on-first-read.
func ownerRepo(owner, name string) *Repo {
	repo := GetRepoAnyOwner(name)
	if repo == nil {
		return nil
	}
	if repo.Owner == "" {
		repo.Owner = owner
		RekeyRepo(repo, owner, name)
	}
	if repo.Owner != owner {
		return nil
	}
	return repo
}

func repoJSON(r *Repo) *OMap {
	owner := r.Owner
	if owner == "" {
		owner = ctxOwnerFallback
	}
	return NewOMap().
		Set("id", int(r.ID)).
		Set("node_id", fmt.Sprintf("R_%d", r.ID)).
		Set("name", r.Name).
		Set("full_name", owner+"/"+r.Name).
		Set("owner", NewOMap().Set("login", owner).Set("id", 1).Set("type", "User")).
		Set("private", r.Private).
		Set("description", r.Description).
		Set("fork", false).
		Set("default_branch", r.DefaultBranch).
		Set("created_at", isoFromLc(r.CreatedAt)).
		Set("updated_at", isoFromLc(LC())).
		Set("pushed_at", isoFromLc(LC())).
		Set("permissions", NewOMap().Set("admin", true).Set("push", true).Set("pull", true))
}

func labelsJSON(labels []string, repo *Repo) []any {
	out := make([]any, 0, len(labels))
	for _, n := range labels {
		color := "ededed"
		if l, ok := repo.Labels[n]; ok {
			color = l.Color
		}
		out = append(out, NewOMap().Set("id", 500+hashStr(n)).Set("name", n).Set("color", color))
	}
	return out
}

func issueJSON(repo *Repo, i *Issue) *OMap {
	var closedAt any
	if i.State == "closed" {
		closedAt = isoFromLc(i.UpdatedAt)
	} else {
		closedAt = nil
	}
	comments := make([]any, 0, len(i.Comments))
	_ = comments
	return NewOMap().
		Set("id", 1000+i.Number).
		Set("node_id", fmt.Sprintf("I_%d", i.Number)).
		Set("number", i.Number).
		Set("title", i.Title).
		Set("body", i.Body).
		Set("state", i.State).
		Set("labels", labelsJSON(i.Labels, repo)).
		Set("comments", len(i.Comments)).
		Set("created_at", isoFromLc(i.CreatedAt)).
		Set("updated_at", isoFromLc(i.UpdatedAt)).
		Set("closed_at", closedAt).
		Set("user", NewOMap().Set("login", repo.Owner))
}

func pullJSON(p *Pull) *OMap {
	var mergedAt any
	if p.MergedAt != nil {
		mergedAt = isoFromLc(*p.MergedAt)
	} else {
		mergedAt = nil
	}
	files := make([]any, 0, len(p.Files))
	for _, f := range p.Files {
		add := len(f.HeadContent) - len(f.BaseContent)
		if add < 1 {
			add = 1
		}
		del := len(f.BaseContent) - len(f.HeadContent)
		if del < 0 {
			del = 0
		}
		status := "modified"
		if f.BaseContent == "" {
			status = "added"
		}
		files = append(files, NewOMap().
			Set("filename", f.Path).
			Set("status", status).
			Set("additions", add).
			Set("deletions", del).
			Set("changes", absInt(len(f.HeadContent)-len(f.BaseContent))))
	}
	return NewOMap().
		Set("id", 2000+p.Number).
		Set("node_id", fmt.Sprintf("PR_%d", p.Number)).
		Set("number", p.Number).
		Set("title", p.Title).
		Set("body", p.Body).
		Set("state", p.State).
		Set("merged", p.Merged).
		Set("merged_at", mergedAt).
		Set("head", NewOMap().Set("ref", p.HeadRef).Set("sha", p.HeadSha).Set("label", p.HeadRef)).
		Set("base", NewOMap().Set("ref", p.BaseRef).Set("sha", p.BaseSha).Set("label", p.BaseRef)).
		Set("merge_commit_sha", nullableString(p.MergeCommitSha)).
		Set("created_at", isoFromLc(p.CreatedAt)).
		Set("updated_at", isoFromLc(p.CreatedAt)).
		Set("user", NewOMap().Set("login", p.BaseRef)).
		Set("files", files)
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// HandleRest serves /api/v3. path = full request path, rawURL = path+query, host = the request's
// Host header (Link headers must stay on the client's origin).
func HandleRest(method, path, rawURL, query, token, owner, host string, body []byte) restResult {
	ctxOwnerFallback = owner
	authed := token != ""
	p := strings.TrimPrefix(path, "/api/v3")
	if p == "" {
		p = "/"
	}
	var parsedBody any
	if method != "GET" && method != "HEAD" && method != "DELETE" {
		if len(body) > 0 {
			v, err := parseSimpleJSON(body)
			if err != nil {
				return msgRest(400, "Problems parsing JSON")
			}
			parsedBody = v
		}
	}
	b := bodyMap(parsedBody)

	// root
	if p == "/" && method == "GET" {
		if !authed {
			return msgRest(401, "Requires authentication", [2]string{"x-oauth-scopes", ""})
		}
		return sendRest(200, NewOMap().Set("current_user_url", "/api/v3/user"), [2]string{"x-oauth-scopes", "repo, read:org"})
	}
	if p == "/meta" && method == "GET" {
		return sendRest(200, NewOMap().Set("installed_version", "1.0.0"))
	}
	if p == "/user" && method == "GET" {
		if !authed {
			return msgRest(401, "Requires authentication")
		}
		return sendRest(200, NewOMap().Set("login", owner).Set("id", 1).Set("type", "User"))
	}

	// user/repos
	if p == "/user/repos" && method == "POST" {
		if !authed {
			return msgRest(401, "Requires authentication")
		}
		name := bStr(b, "name")
		if name == "" {
			return msgRest(422, "name is required")
		}
		if GetRepoAnyOwner(name) != nil {
			return msgRest(422, "name already exists on this account")
		}
		repo := CreateRepo("", name, bBool(b, "private"), bStr(b, "description"))
		return sendRest(201, repoJSON(repo))
	}
	if p == "/user/repos" && method == "GET" {
		if !authed {
			return msgRest(401, "Requires authentication")
		}
		all := ListRepos()
		perPage := clampIntArg(queryGet(query, "per_page"), 30, 1, 100)
		page := clampIntArg(queryGet(query, "page"), 1, 1, 1<<30)
		start := (page - 1) * perPage
		end := page * perPage
		if start > len(all) {
			start = len(all)
		}
		if end > len(all) {
			end = len(all)
		}
		slice := all[start:end]
		list := make([]any, 0, len(slice))
		for _, r := range slice {
			list = append(list, repoJSON(r))
		}
		var headers [][2]string
		if page*perPage < len(all) {
			if host == "" {
				host = "127.0.0.1"
			}
			base := "http://" + host + strings.SplitN(rawURL, "?", 2)[0]
			last := (len(all) + perPage - 1) / perPage
			link := fmt.Sprintf(`<%s?per_page=%d&page=%d>; rel="next", <%s?per_page=%d&page=%d>; rel="last"`,
				base, perPage, page+1, base, perPage, last)
			headers = append(headers, [2]string{"link", link})
		}
		return sendRest(200, list, headers...)
	}

	// /repos/{owner}/{repo}/...
	rest := strings.TrimPrefix(p, "/repos/")
	seg := strings.SplitN(rest, "/", 3)
	if len(seg) >= 2 {
		ownerName := urlUnescape(seg[0])
		name := urlUnescape(seg[1])
		sub := ""
		if len(seg) == 3 {
			sub = "/" + seg[2]
		}
		repo := ownerRepo(ownerName, name)
		return handleRepoSub(method, rawURL, query, token, ownerName, repo, name, sub, parsedBody)
	}

	return msgRest(404, "Not Found")
}

func clampIntArg(s string, def, min, max int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < min {
		if err != nil {
			return def
		}
		return min
	}
	if n > max {
		return max
	}
	return n
}

func handleRepoSub(method, rawURL, query, token, ownerName string, repo *Repo, name, sub string, parsedBody any) restResult {
	b := bodyMap(parsedBody)
	authed := token != ""

	if sub == "" || sub == "/" {
		switch method {
		case "GET":
			if !authed {
				return msgRest(401, "Requires authentication")
			}
			if repo == nil {
				return msgRest(404, "Not Found")
			}
			return sendRest(200, repoJSON(repo))
		case "PATCH":
			if !authed {
				return msgRest(401, "Requires authentication")
			}
			if repo == nil {
				return msgRest(404, "Not Found")
			}
			if v, ok := b.Get("description"); ok {
				if s, ok := v.(string); ok {
					repo.Description = s
				}
			}
			return sendRest(200, repoJSON(repo))
		case "DELETE":
			if !authed {
				return msgRest(401, "Requires authentication")
			}
			if repo == nil {
				return msgRest(404, "Not Found")
			}
			DeleteRepo(ownerName, name)
			return restResult{204, nil, [][2]string{{"x-github-request-id", requestIDHeader()}}}
		}
		return msgRest(404, "Not Found")
	}

	if repo == nil {
		return msgRest(404, "Not Found")
	}

	// git refs (branch create)
	if sub == "/git/refs" && method == "POST" {
		ref := bStr(b, "ref")
		sha := bStr(b, "sha")
		branchName := strings.TrimPrefix(ref, "refs/heads/")
		if ref == "" || sha == "" {
			return msgRest(422, "ref and sha required")
		}
		if _, exists := repo.Branches[branchName]; exists || (branchName == repo.DefaultBranch && len(repo.Branches) == 0) {
			return msgRest(422, "Reference already exists")
		}
		repo.Branches[branchName] = sha
		return sendRest(201, NewOMap().Set("ref", ref).Set("object", NewOMap().Set("sha", sha).Set("type", "commit")))
	}

	// branches
	if sub == "/branches" && method == "GET" {
		list := make([]any, 0, len(repo.Branches)+1)
		if len(repo.Branches) == 0 {
			list = append(list, NewOMap().Set("name", repo.DefaultBranch).Set("commit", NewOMap().Set("sha", "unknown-yet")).Set("protected", false))
		} else {
			for _, n := range repo.BranchNames() {
				list = append(list, NewOMap().Set("name", n).Set("commit", NewOMap().Set("sha", repo.Branches[n])).Set("protected", false))
			}
		}
		return sendRest(200, list)
	}

	// commits
	if sub == "/commits" && method == "GET" {
		ref := queryGet(query, "sha")
		if ref == "" {
			ref = queryGet(query, "ref")
		}
		if ref == "" {
			ref = repo.DefaultBranch
		}
		tip, hasTip := repo.Branches[ref]
		var list []any
		cur := tip
		if hasTip {
			for cur != "" {
				c, ok := repo.Commits[cur]
				if !ok {
					break
				}
				parents := make([]any, 0, len(c.Parents))
				for _, psha := range c.Parents {
					parents = append(parents, NewOMap().Set("sha", psha))
				}
				date := isoFromLc(c.LC)
				list = append(list, NewOMap().
					Set("sha", c.Sha).
					Set("commit", NewOMap().
						Set("message", c.Message).
						Set("author", NewOMap().Set("name", "forge").Set("date", date)).
						Set("committer", NewOMap().Set("name", "forge").Set("date", date))).
					Set("parents", parents))
				if len(c.Parents) == 0 {
					break
				}
				cur = c.Parents[0]
			}
		}
		if list == nil {
			list = []any{}
		}
		return sendRest(200, list)
	}

	// contents
	if strings.HasPrefix(sub, "/contents/") {
		cpath := strings.TrimPrefix(sub, "/contents/")
		switch method {
		case "PUT":
			return handlePutContent(repo, cpath, b)
		case "GET":
			return handleGetContent(repo, cpath, query)
		case "DELETE":
			return handleDeleteContent(repo, cpath, b)
		}
	}

	// labels
	if sub == "/labels" && method == "POST" {
		lname := bStr(b, "name")
		if lname == "" {
			return msgRest(422, "name required")
		}
		color := "ededed"
		if v, ok := b.Get("color"); ok {
			if s, ok := v.(string); ok {
				color = s
			}
		}
		if _, exists := repo.Labels[lname]; !exists {
			repo.labelOrder = append(repo.labelOrder, lname)
		}
		repo.Labels[lname] = &Label{Name: lname, Color: color}
		return sendRest(201, NewOMap().Set("id", 500+hashStr(lname)).Set("name", lname).Set("color", color))
	}

	// issues
	if sub == "/issues" && method == "POST" {
		return handleCreateIssue(repo, b)
	}
	if sub == "/issues" && method == "GET" {
		return handleListIssues(repo, query)
	}
	if m := reIssuePath.FindStringSubmatch(sub); m != nil {
		n, _ := strconv.Atoi(m[1])
		issue := repo.Issues[n]
		if m[2] == "" {
			switch method {
			case "GET":
				if issue == nil {
					return msgRest(404, "Not Found")
				}
				// memoized serialized body keyed by the issue's version stamp
				if hit, ok := repo.IssueBodyCache[issue.Number]; ok && hit.Ver == issue.UpdatedAt {
					return restResult{200, []byte(hit.Body), [][2]string{{"x-github-request-id", requestIDHeader()}}}
				}
				text := string(jsonBody(issueJSON(repo, issue)))
				repo.IssueBodyCache[issue.Number] = issueBodyCacheEntry{Ver: issue.UpdatedAt, Body: text}
				return restResult{200, []byte(text), [][2]string{{"x-github-request-id", requestIDHeader()}}}
			case "PATCH":
				if issue == nil {
					return msgRest(404, "Not Found")
				}
				if v, ok := b.Get("state"); ok {
					if s, ok := v.(string); ok {
						if s == "closed" || s == "open" {
							issue.State = s
							issue.UpdatedAt = LC()
						}
					}
				}
				if v, ok := b.Get("title"); ok {
					if s, ok := v.(string); ok {
						issue.Title = s
					}
				}
				if v, ok := b.Get("body"); ok {
					if s, ok := v.(string); ok {
						issue.Body = s
					}
				}
				return sendRest(200, issueJSON(repo, issue))
			}
		} else {
			// comments
			switch method {
			case "POST":
				if issue == nil {
					return msgRest(404, "Not Found")
				}
				cbody := bStr(b, "body")
				id := int64(len(issue.Comments) + 1 + 8000)
				issue.Comments = append(issue.Comments, Comment{ID: id, Body: cbody, LC: LC()})
				return sendRest(201, NewOMap().Set("id", id).Set("body", cbody))
			case "GET":
				if issue == nil {
					return msgRest(404, "Not Found")
				}
				list := make([]any, 0, len(issue.Comments))
				for _, c := range issue.Comments {
					list = append(list, NewOMap().Set("id", c.ID).Set("body", c.Body).Set("user", NewOMap().Set("login", repo.Owner)).Set("created_at", isoFromLc(c.LC)))
				}
				return sendRest(200, list)
			}
		}
	}

	// pulls
	if sub == "/pulls" && method == "POST" {
		return handleCreatePull(repo, b)
	}
	if sub == "/pulls" && method == "GET" {
		return handleListPulls(repo, query)
	}
	if m := rePullPath.FindStringSubmatch(sub); m != nil {
		n, _ := strconv.Atoi(m[1])
		pull := repo.Pulls[n]
		if pull == nil {
			return msgRest(404, "Not Found")
		}
		if m[2] == "" && method == "GET" {
			return sendRest(200, pullJSON(pull))
		}
		if m[3] == "files" && method == "GET" {
			list := make([]any, 0, len(pull.Files))
			for _, f := range pull.Files {
				add := len(f.HeadContent) - len(f.BaseContent)
				if add < 1 {
					add = 1
				}
				del := len(f.BaseContent) - len(f.HeadContent)
				if del < 0 {
					del = 0
				}
				status := "modified"
				if f.BaseContent == "" {
					status = "added"
				}
				list = append(list, NewOMap().
					Set("filename", f.Path).Set("status", status).Set("additions", add).Set("deletions", del).
					Set("changes", absInt(len(f.HeadContent)-len(f.BaseContent))).
					Set("blob_url", "").Set("raw_url", "").Set("contents_url", ""))
			}
			return sendRest(200, list)
		}
		if m[3] == "merge" && method == "PUT" {
			return handleMergePull(repo, pull)
		}
	}

	return msgRest(404, "Not Found")
}

var reIssuePath = regexp.MustCompile(`^/issues/(\d+)(/comments)?$`)
var rePullPath = regexp.MustCompile(`^/pulls/(\d+)(/(files|merge))?$`)

// ---------- contents ----------

func findBranch(repo *Repo, wanted string) (name, sha string, ok bool) {
	if len(repo.Branches) == 0 {
		return repo.DefaultBranch, "", true
	}
	if wanted == "" {
		wanted = repo.DefaultBranch
	}
	sha, ok = repo.Branches[wanted]
	if !ok {
		return "", "", false
	}
	return wanted, sha, true
}

func commitFile(repo *Repo, branch, baseSha, cpath, content, message string) (commitSha, contentSha string) {
	contentSha = HonestBlob(repo, content)
	tree := make(map[string]string)
	if baseSha != "" {
		if base, ok := repo.Commits[baseSha]; ok {
			for k, v := range base.Tree {
				tree[k] = v
			}
		}
	}
	tree[cpath] = contentSha
	parents := []string{}
	if baseSha != "" {
		parents = append(parents, baseSha)
	}
	commitSha = HonestCommit(repo, tree, parents, message)
	repo.Branches[branch] = commitSha
	return
}

func handlePutContent(repo *Repo, cpath string, b *OMap) restResult {
	content := bStr(b, "content")
	message := bStr(b, "message")
	branch := bStr(b, "branch")
	if branch == "" {
		branch = repo.DefaultBranch
	}
	decoded := content
	if d, err := base64.StdEncoding.DecodeString(content); err == nil {
		decoded = string(d)
	} else if d2, err := base64.RawStdEncoding.DecodeString(content); err == nil {
		decoded = string(d2)
	}
	bName, bSha, ok := findBranch(repo, branch)
	if !ok {
		return msgRest(404, "branch "+branch+" not found")
	}
	var existing string
	var hasExisting bool
	if bSha != "" {
		if c, ok := repo.Commits[bSha]; ok {
			existing, hasExisting = c.Tree[cpath]
		}
	}

	if shaArg := bStr(b, "sha"); shaArg != "" {
		if !hasExisting {
			return msgRest(409, cpath+" does not exist")
		}
		if shaArg != existing {
			return msgRest(409, cpath+" sha does not match")
		}
		commitSha, contentSha := commitFile(repo, bName, bSha, cpath, decoded, message)
		return sendRest(200, putContentJSON(cpath, decoded, contentSha, commitSha, message))
	}
	commitSha, contentSha := commitFile(repo, bName, bSha, cpath, decoded, message)
	return sendRest(201, putContentJSON(cpath, decoded, contentSha, commitSha, message))
}

func putContentJSON(cpath, decoded, contentSha, commitSha, message string) *OMap {
	name := cpath
	if idx := strings.LastIndexByte(cpath, '/'); idx >= 0 {
		name = cpath[idx+1:]
	}
	return NewOMap().
		Set("content", NewOMap().
			Set("sha", contentSha).
			Set("encoding", "base64").
			Set("content", base64.StdEncoding.EncodeToString([]byte(decoded))).
			Set("name", name).
			Set("path", cpath).
			Set("size", len(decoded))).
		Set("commit", NewOMap().Set("sha", commitSha).Set("message", message))
}

func handleGetContent(repo *Repo, cpath, query string) restResult {
	ref := queryGet(query, "ref")
	if ref == "" {
		ref = repo.DefaultBranch
	}
	tip, hasTip := repo.Branches[ref]
	if !hasTip && len(repo.Branches) > 0 {
		return msgRest(404, "Not Found")
	}
	var commit *CommitNode
	if hasTip {
		commit = repo.Commits[tip]
	}
	var tree map[string]string
	if commit != nil {
		tree = commit.Tree
	} else {
		tree = map[string]string{}
	}
	blobSha, isFile := tree[cpath]
	if !isFile {
		// directory listing
		prefix := cpath
		if !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		names := map[string]bool{}
		for p := range tree {
			if strings.HasPrefix(p, prefix) && len(p) > len(prefix) {
				names[strings.SplitN(p[len(prefix):], "/", 2)[0]] = true
			}
		}
		if len(names) == 0 {
			return msgRest(404, "Not Found")
		}
		sorted := make([]string, 0, len(names))
		for n := range names {
			sorted = append(sorted, n)
		}
		sort.Strings(sorted)
		entries := make([]any, 0, len(sorted))
		for _, n := range sorted {
			full := prefix + n
			_, fileHere := tree[full]
			e := NewOMap().Set("type", "file").Set("name", n).Set("path", full)
			if fileHere {
				e.Set("sha", tree[full]).Set("size", 0).Set("encoding", "base64")
			} else {
				e.Set("sha", NewSha(repo.Owner+"/"+repo.Name+":"+full+":dir")).Set("size", 0)
			}
			entries = append(entries, e)
		}
		return sendRest(200, entries)
	}
	content := repo.BlobStore[blobSha]
	name := cpath
	if idx := strings.LastIndexByte(cpath, '/'); idx >= 0 {
		name = cpath[idx+1:]
	}
	return sendRest(200, NewOMap().
		Set("sha", blobSha).
		Set("node_id", "B_"+blobSha[:8]).
		Set("name", name).
		Set("path", cpath).
		Set("size", len(content)).
		Set("encoding", "base64").
		Set("content", base64.StdEncoding.EncodeToString([]byte(content))).
		Set("type", "file"))
}

func handleDeleteContent(repo *Repo, cpath string, b *OMap) restResult {
	branch := bStr(b, "branch")
	if branch == "" {
		branch = repo.DefaultBranch
	}
	tip, hasTip := repo.Branches[branch]
	var commit *CommitNode
	if hasTip {
		commit = repo.Commits[tip]
	}
	var tree map[string]string
	if commit != nil {
		tree = commit.Tree
	} else {
		tree = map[string]string{}
	}
	if _, ok := tree[cpath]; !ok {
		return msgRest(404, "Not Found")
	}
	newTree := make(map[string]string, len(tree))
	for k, v := range tree {
		if k != cpath {
			newTree[k] = v
		}
	}
	parents := []string{}
	if hasTip {
		parents = append(parents, tip)
	}
	message := bStr(b, "message")
	if message == "" {
		message = "delete"
	}
	sha := HonestCommit(repo, newTree, parents, message)
	repo.Branches[branch] = sha
	return sendRest(200, NewOMap().Set("commit", NewOMap().Set("sha", sha).Set("message", message)))
}

// ---------- issues ----------

func handleCreateIssue(repo *Repo, b *OMap) restResult {
	title := bStr(b, "title")
	body := bStr(b, "body")
	var labelsIn []string
	if v, ok := b.Get("labels"); ok {
		if arr, ok := v.([]any); ok {
			for _, e := range arr {
				if s, ok := e.(string); ok {
					labelsIn = append(labelsIn, s)
				}
			}
		}
	}
	for _, l := range labelsIn {
		if _, ok := repo.Labels[l]; !ok {
			return msgRest(422, "label "+l+" does not exist")
		}
	}
	repo.IssueSeq++
	n := repo.IssueSeq
	issue := &Issue{Number: n, Title: title, Body: body, State: "open", Labels: labelsIn, CreatedAt: LC(), UpdatedAt: LC()}
	repo.PutIssue(issue)
	return sendRest(201, issueJSON(repo, issue))
}

func handleListIssues(repo *Repo, query string) restResult {
	state := queryGet(query, "state")
	if state == "" {
		state = "open"
	}
	sortKey := queryGet(query, "sort")
	if sortKey == "" {
		sortKey = "created"
	}
	dir := queryGet(query, "direction")
	if dir == "" {
		dir = "desc"
	}
	list := repo.IssueList()
	if state != "all" {
		filtered := list[:0]
		for _, i := range list {
			if i.State == state {
				filtered = append(filtered, i)
			}
		}
		list = filtered
	}
	sort.SliceStable(list, func(a, bIdx int) bool {
		var cmp int64
		if sortKey == "created" {
			cmp = list[a].CreatedAt - list[bIdx].CreatedAt
		} else {
			cmp = list[a].UpdatedAt - list[bIdx].UpdatedAt
		}
		if dir == "asc" {
			return cmp < 0
		}
		return cmp > 0
	})
	out := make([]any, 0, len(list))
	for _, i := range list {
		out = append(out, issueJSON(repo, i))
	}
	return sendRest(200, out)
}

// ---------- pulls ----------

func handleCreatePull(repo *Repo, b *OMap) restResult {
	head := bStr(b, "head")
	base := bStr(b, "base")
	title := bStr(b, "title")
	body := bStr(b, "body")
	headSha, hasHead := repo.Branches[head]
	baseSha, hasBase := repo.Branches[base]
	if !hasHead || !hasBase {
		return msgRest(422, "head or base branch does not exist")
	}
	var headCommit, baseCommit *CommitNode
	if h, ok := repo.Commits[headSha]; ok {
		headCommit = h
	}
	if bs, ok := repo.Commits[baseSha]; ok {
		baseCommit = bs
	}
	headTree := map[string]string{}
	baseTree := map[string]string{}
	if headCommit != nil {
		headTree = headCommit.Tree
	}
	if baseCommit != nil {
		baseTree = baseCommit.Tree
	}
	allPaths := map[string]bool{}
	for p := range headTree {
		allPaths[p] = true
	}
	for p := range baseTree {
		allPaths[p] = true
	}
	sortedPaths := make([]string, 0, len(allPaths))
	for p := range allPaths {
		sortedPaths = append(sortedPaths, p)
	}
	sort.Strings(sortedPaths)
	var files []PullFile
	for _, path := range sortedPaths {
		h, inHead := headTree[path]
		bs, inBase := baseTree[path]
		if inHead && inBase && h == bs {
			continue
		}
		hc, bc := "", ""
		if inHead {
			hc = repo.BlobStore[h]
		}
		if inBase {
			bc = repo.BlobStore[bs]
		}
		files = append(files, PullFile{Path: path, HeadContent: hc, BaseContent: bc})
	}
	repo.PullSeq++
	n := repo.PullSeq
	pull := &Pull{
		Number: n, Title: title, Body: body, State: "open",
		HeadRef: head, HeadSha: headSha, BaseRef: base, BaseSha: baseSha,
		CreatedAt: LC(), Files: files,
	}
	repo.PutPull(pull)
	return sendRest(201, pullJSON(pull))
}

func handleListPulls(repo *Repo, query string) restResult {
	state := queryGet(query, "state")
	if state == "" {
		state = "open"
	}
	var out []any
	for _, p := range repo.PullList() {
		if state == "open" && p.State != "open" {
			continue
		}
		if state == "merged" && !p.Merged {
			continue
		}
		if state == "closed" && (p.State != "closed" || p.Merged) {
			continue
		}
		out = append(out, pullJSON(p))
	}
	if out == nil {
		out = []any{}
	}
	return sendRest(200, out)
}

func handleMergePull(repo *Repo, pull *Pull) restResult {
	if pull.Merged {
		return msgRest(405, "pull request already merged")
	}
	currentBaseSha, hasBase := repo.Branches[pull.BaseRef]
	if !hasBase {
		currentBaseSha = pull.BaseSha
	}
	baseTip := repo.Commits[currentBaseSha]
	headTip := repo.Commits[pull.HeadSha]
	if baseTip == nil || headTip == nil {
		return msgRest(405, "branches are gone")
	}
	branchPoint := ""
	if len(headTip.Parents) > 0 {
		branchPoint = headTip.Parents[0]
	}
	// any file the pull touches that also changed on base since the branch point -> conflict
	conflicted := false
	walkSet := map[string]bool{}
	cur := baseTip.Sha
	for cur != "" && !walkSet[cur] {
		walkSet[cur] = true
		if cur == branchPoint {
			break
		}
		c, ok := repo.Commits[cur]
		if !ok {
			break
		}
		for _, f := range pull.Files {
			if _, changed := c.Tree[f.Path]; changed {
				conflicted = true
			}
		}
		if len(c.Parents) == 0 {
			break
		}
		cur = c.Parents[0]
	}
	if conflicted {
		return msgRest(405, "merge conflict")
	}
	newTree := make(map[string]string, len(headTip.Tree))
	for k, v := range headTip.Tree {
		newTree[k] = v
	}
	sha := HonestCommit(repo, newTree, []string{baseTip.Sha}, fmt.Sprintf("Merge pull #%d (squash): %s", pull.Number, pull.Title))
	repo.Branches[pull.BaseRef] = sha
	pull.BaseSha = baseTip.Sha
	pull.State = "closed"
	pull.Merged = true
	pull.MergeCommitSha = sha
	at := LC()
	pull.MergedAt = &at
	return sendRest(200, NewOMap().Set("merged", true).Set("sha", sha).Set("message", "Pull request successfully merged and closed"))
}
