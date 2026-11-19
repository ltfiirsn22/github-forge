// go/mcp.go — MCP streamable-HTTP endpoint ported from mcp.ts: server/discover, initialize,
// tools/list (byte-identical), tools/call for the six required tools.
package main

import (
	"fmt"
	"strconv"
	"strings"
)

const mcpServerName = "forge-mcp"
const mcpServerVersion = "1.0.0"

var mcpSupportedVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18"}

const (
	mcpParseError     = -32700
	mcpInvalidParams  = -32602
	mcpMethodNotFound = -32601
)

type mcpResult struct {
	status int
	body   []byte // full JSON body with newline
}

func mcpRespond(status int, body any) mcpResult {
	return mcpResult{status, jsonBody(body)}
}

func rpcResultOMap(id any, result *OMap) *OMap {
	return NewOMap().Set("jsonrpc", "2.0").Set("id", id).Set("result", result)
}

func rpcResultAny(id any, result any) *OMap {
	return NewOMap().Set("jsonrpc", "2.0").Set("id", id).Set("result", result)
}

func rpcErrorOMap(id any, code int, message string) *OMap {
	if id == nil {
		id = nil
	}
	return NewOMap().Set("jsonrpc", "2.0").Set("id", id).
		Set("error", NewOMap().Set("code", code).Set("message", message))
}

func textResultOMap(value any, isError bool) *OMap {
	text := ""
	if s, ok := value.(string); ok {
		text = s
	} else {
		text = string(mustJSON(value))
	}
	content := NewOMap().Set("type", "text").Set("text", text)
	out := NewOMap().Set("content", []any{content})
	if _, isStr := value.(string); !isStr {
		out.Set("structuredContent", value)
	}
	out.Set("isError", isError)
	return out
}

func requireMcpFields(args *OMap, fields ...string) []string {
	var missing []string
	for _, f := range fields {
		v, ok := args.Get(f)
		if !ok || v == nil {
			missing = append(missing, f)
			continue
		}
		if s, isStr := v.(string); isStr && s == "" {
			missing = append(missing, f)
		}
	}
	return missing
}

func mcpRepoOf(args *OMap) *Repo {
	owner := bStr(args, "owner")
	name := bStr(args, "repo")
	if name == "" {
		name = bStr(args, "repository")
	}
	if name == "" {
		name = bStr(args, "repo_name")
	}
	if name == "" {
		if fn := bStr(args, "full_name"); strings.Contains(fn, "/") {
			parts := strings.SplitN(fn, "/", 2)
			owner, name = parts[0], parts[1]
		}
	}
	if name == "" {
		return nil
	}
	repo := GetRepoAnyOwner(name)
	if repo == nil {
		return nil
	}
	resolved := repo.Owner
	if resolved == "" {
		if owner != "" {
			resolved = owner
		} else {
			resolved = CurrentViewer()
		}
	}
	if owner != "" && owner != resolved && repo.Owner != "" {
		return nil
	}
	return repo
}

func mcpRepoJSON(repo *Repo) *OMap {
	owner := repo.Owner
	if owner == "" {
		owner = CurrentViewer()
	}
	return NewOMap().
		Set("id", int(repo.ID)).
		Set("node_id", fmt.Sprintf("R_%d", repo.ID)).
		Set("name", repo.Name).
		Set("full_name", owner+"/"+repo.Name).
		Set("owner", NewOMap().Set("login", owner)).
		Set("private", repo.Private).
		Set("description", repo.Description).
		Set("default_branch", repo.DefaultBranch).
		Set("created_at", "1970-01-01T00:00:00.000Z")
}

func mcpIssueJSON(repo *Repo, issue *Issue) *OMap {
	owner := repo.Owner
	if owner == "" {
		owner = CurrentViewer()
	}
	return NewOMap().
		Set("id", 1000+issue.Number).
		Set("number", issue.Number).
		Set("title", issue.Title).
		Set("body", issue.Body).
		Set("state", issue.State).
		Set("user", NewOMap().Set("login", owner)).
		Set("comments", len(issue.Comments))
}

func mcpPullJSON(repo *Repo, pull *Pull) *OMap {
	owner := repo.Owner
	if owner == "" {
		owner = CurrentViewer()
	}
	state := pull.State
	if pull.Merged {
		state = "closed"
	}
	return NewOMap().
		Set("id", 2000+pull.Number).
		Set("number", pull.Number).
		Set("title", pull.Title).
		Set("state", state).
		Set("merged", pull.Merged).
		Set("head", NewOMap().Set("ref", pull.HeadRef).Set("sha", pull.HeadSha)).
		Set("base", NewOMap().Set("ref", pull.BaseRef).Set("sha", pull.BaseSha)).
		Set("user", NewOMap().Set("login", owner))
}

// ---------- tools ----------

type mcpTool struct {
	name        string
	description string
	schema      *OMap
	required    []string
	run         func(args *OMap) (*OMap, string) // (json, errorText)
}

func objSchemaMcp(properties *OMap, required ...string) *OMap {
	return NewOMap().Set("type", "object").Set("properties", properties).Set("required", required)
}

func propDesc(typ, desc string) *OMap {
	return NewOMap().Set("type", typ).Set("description", desc)
}

var mcpTools = []mcpTool{
	{
		name:        "create_repo",
		description: "Create a repository owned by the authenticated viewer",
		schema: objSchemaMcp(NewOMap().
			Set("name", propDesc("string", "repository name")).
			Set("description", propDesc("string", "repository description")).
			Set("private", propDesc("boolean", "private repository")).
			Set("owner", propDesc("string", "owner login")), "name"),
		required: []string{"name"},
		run: func(args *OMap) (*OMap, string) {
			if miss := requireMcpFields(args, "name"); len(miss) > 0 {
				return nil, "missing required argument: " + miss[0]
			}
			name := bStr(args, "name")
			if name == "" {
				name = bStr(args, "repo")
			}
			owner := bStr(args, "owner")
			if owner == "" {
				owner = CurrentViewer()
			}
			if existing := GetRepoAnyOwner(name); existing != nil {
				return mcpRepoJSON(existing), ""
			}
			repo := CreateRepo(owner, name, bBool(args, "private"), bStr(args, "description"))
			return mcpRepoJSON(repo), ""
		},
	},
	{
		name:        "get_repo",
		description: "Read one repository by owner and name",
		schema: objSchemaMcp(NewOMap().
			Set("owner", propDesc("string", "owner login")).
			Set("repo", propDesc("string", "repository name")), "owner", "repo"),
		required: []string{"owner", "repo"},
		run: func(args *OMap) (*OMap, string) {
			repo := mcpRepoOf(args)
			if repo == nil {
				return nil, "repository not found"
			}
			return mcpRepoJSON(repo), ""
		},
	},
	{
		name:        "create_issue",
		description: "Create an issue in a repository",
		schema: objSchemaMcp(NewOMap().
			Set("owner", propDesc("string", "owner login")).
			Set("repo", propDesc("string", "repository name")).
			Set("title", propDesc("string", "issue title")).
			Set("body", propDesc("string", "issue body")), "owner", "repo", "title"),
		required: []string{"owner", "repo", "title"},
		run: func(args *OMap) (*OMap, string) {
			if miss := requireMcpFields(args, "title"); len(miss) > 0 {
				return nil, "missing required argument: " + miss[0]
			}
			repo := mcpRepoOf(args)
			if repo == nil {
				return nil, "repository not found"
			}
			repo.IssueSeq++
			n := repo.IssueSeq
			issue := &Issue{Number: n, Title: bStr(args, "title"), Body: bStr(args, "body"), State: "open", CreatedAt: LC(), UpdatedAt: LC()}
			repo.PutIssue(issue)
			return mcpIssueJSON(repo, issue), ""
		},
	},
	{
		name:        "list_issues",
		description: "List the issues of a repository, optionally filtered by state",
		schema: objSchemaMcp(NewOMap().
			Set("owner", propDesc("string", "owner login")).
			Set("repo", propDesc("string", "repository name")).
			Set("state", propDesc("string", "open | closed | all")), "owner", "repo"),
		required: []string{"owner", "repo"},
		run: func(args *OMap) (*OMap, string) {
			repo := mcpRepoOf(args)
			if repo == nil {
				return nil, "repository not found"
			}
			state := strings.ToLower(bStr(args, "state"))
			if state == "" {
				state = "open"
			}
			var out []any
			for _, i := range repo.IssueList() {
				if state == "all" || i.State == state {
					out = append(out, mcpIssueJSON(repo, i))
				}
			}
			if out == nil {
				out = []any{}
			}
			return NewOMap().Set("list", out), ""
		},
	},
	{
		name:        "create_pull_request",
		description: "Open a pull request from a head branch into a base branch",
		schema: objSchemaMcp(NewOMap().
			Set("owner", propDesc("string", "owner login")).
			Set("repo", propDesc("string", "repository name")).
			Set("title", propDesc("string", "pull request title")).
			Set("body", propDesc("string", "pull request body")).
			Set("head", propDesc("string", "head branch")).
			Set("base", propDesc("string", "base branch")), "owner", "repo", "title", "head", "base"),
		required: []string{"owner", "repo", "title", "head", "base"},
		run: func(args *OMap) (*OMap, string) {
			if miss := requireMcpFields(args, "title", "head"); len(miss) > 0 {
				return nil, "missing required argument: " + miss[0]
			}
			repo := mcpRepoOf(args)
			if repo == nil {
				return nil, "repository not found"
			}
			head := bStr(args, "head")
			base := bStr(args, "base")
			if base == "" {
				base = repo.DefaultBranch
			}
			headSha, hasHead := repo.Branches[head]
			baseSha, hasBase := repo.Branches[base]
			if !hasHead || !hasBase {
				return nil, "head or base branch does not exist"
			}
			var headCommit, baseCommit *CommitNode
			if h, ok := repo.Commits[headSha]; ok {
				headCommit = h
			}
			if b, ok := repo.Commits[baseSha]; ok {
				baseCommit = b
			}
			var files []PullFile
			allPaths := map[string]bool{}
			headTree, baseTree := map[string]string{}, map[string]string{}
			if headCommit != nil {
				headTree = headCommit.Tree
			}
			if baseCommit != nil {
				baseTree = baseCommit.Tree
			}
			for p := range headTree {
				allPaths[p] = true
			}
			for p := range baseTree {
				allPaths[p] = true
			}
			for p := range allPaths {
				h, inHead := headTree[p]
				bsha, inBase := baseTree[p]
				if inHead && inBase && h == bsha {
					continue
				}
				files = append(files, PullFile{Path: p})
			}
			repo.PullSeq++
			n := repo.PullSeq
			pull := &Pull{
				Number: n, Title: bStr(args, "title"), Body: bStr(args, "body"), State: "open",
				HeadRef: head, HeadSha: headSha, BaseRef: base, BaseSha: baseSha,
				CreatedAt: LC(), Files: files,
			}
			repo.PutPull(pull)
			return mcpPullJSON(repo, pull), ""
		},
	},
	{
		name:        "merge_pull_request",
		description: "Squash-merge a pull request",
		schema: objSchemaMcp(NewOMap().
			Set("owner", propDesc("string", "owner login")).
			Set("repo", propDesc("string", "repository name")).
			Set("pull_number", propDesc("number", "pull request number")), "owner", "repo", "pull_number"),
		required: []string{"owner", "repo", "pull_number"},
		run: func(args *OMap) (*OMap, string) {
			if miss := requireMcpFields(args, "pull_number"); len(miss) > 0 {
				return nil, "missing required argument: " + miss[0]
			}
			repo := mcpRepoOf(args)
			if repo == nil {
				return nil, "repository not found"
			}
			number := 0
			if f, ok := bFloat(args, "pull_number"); ok {
				number = int(f)
			} else {
				number, _ = strconv.Atoi(bStr(args, "pull_number"))
			}
			pull := repo.Pulls[number]
			if pull == nil {
				return nil, "pull request not found"
			}
			var headTip, baseTip *CommitNode
			if h, ok := repo.Commits[pull.HeadSha]; ok {
				headTip = h
			}
			if b, ok := repo.Commits[repo.Branches[pull.BaseRef]]; ok {
				baseTip = b
			}
			if headTip != nil && baseTip != nil {
				newTree := make(map[string]string, len(headTip.Tree))
				for k, v := range headTip.Tree {
					newTree[k] = v
				}
				sha := HonestCommit(repo, newTree, []string{baseTip.Sha}, fmt.Sprintf("Merge pull #%d (squash): %s", pull.Number, pull.Title))
				repo.Branches[pull.BaseRef] = sha
				pull.MergeCommitSha = sha
			}
			pull.Merged = true
			pull.State = "closed"
			at := LC()
			pull.MergedAt = &at
			out := mcpPullJSON(repo, pull)
			out.Set("merged", true)
			out.Set("state", "closed")
			return out, ""
		},
	},
}

// toolsListJSON is serialized once: two tools/list calls must be byte-identical.
var toolsListJSON = func() []byte {
	list := make([]any, 0, len(mcpTools))
	for _, t := range mcpTools {
		req := make([]any, 0, len(t.required))
		for _, r := range t.required {
			req = append(req, r)
		}
		list = append(list, NewOMap().
			Set("name", t.name).
			Set("description", t.description).
			Set("inputSchema", NewOMap().Set("type", "object").
				Set("properties", omProp(t.schema)).
				Set("required", req)))
	}
	return mustJSON(list)
}()

// ---------- dispatch ----------

func handleMcpRpc(method string, params *OMap, id any) mcpResult {
	switch method {
	case "server/discover":
		result := NewOMap().
			Set("resultType", "discover").
			Set("supportedVersions", mcpSupportedVersions).
			Set("capabilities", NewOMap().Set("tools", NewOMap().Set("listChanged", false))).
			Set("serverInfo", NewOMap().Set("name", mcpServerName).Set("version", mcpServerVersion)).
			Set("instructions", "GitHub-compatible forge tools")
		return mcpRespond(200, rpcResultAny(id, result))
	case "initialize":
		requested := bStr(params, "protocolVersion")
		if requested == "" {
			if meta, ok := params.Get("_meta"); ok {
				if m, ok := meta.(*OMap); ok {
					requested = bStr(m, "io.modelcontextprotocol/protocolVersion")
				}
			}
		}
		chosen := mcpSupportedVersions[0]
		for _, v := range mcpSupportedVersions {
			if v == requested {
				chosen = requested
				break
			}
		}
		result := NewOMap().
			Set("protocolVersion", chosen).
			Set("capabilities", NewOMap().Set("tools", NewOMap().Set("listChanged", false))).
			Set("serverInfo", NewOMap().Set("name", mcpServerName).Set("version", mcpServerVersion))
		return mcpRespond(200, rpcResultAny(id, result))
	case "tools/list":
		return mcpRespond(200, rpcResultAny(id, NewOMap().Set("tools", jsonRaw(toolsListJSON))))
	case "tools/call":
		name := bStr(params, "name")
		args := NewOMap()
		if v, ok := params.Get("arguments"); ok {
			if m, ok := v.(*OMap); ok {
				args = m
			}
		}
		var tool *mcpTool
		for i := range mcpTools {
			if mcpTools[i].name == name {
				tool = &mcpTools[i]
				break
			}
		}
		if tool == nil {
			return mcpRespond(200, rpcErrorOMap(id, mcpMethodNotFound, "tool not found: "+name))
		}
		miss := requireMcpFields(args, tool.required...)
		if len(miss) > 0 {
			return mcpRespond(200, rpcErrorOMap(id, mcpInvalidParams, "missing required argument(s): "+strings.Join(miss, ", ")))
		}
		json, errText := tool.run(args)
		if errText != "" {
			return mcpRespond(200, rpcResultAny(id, textResultOMap(errText, true)))
		}
		return mcpRespond(200, rpcResultAny(id, textResultOMap(json, false)))
	case "notifications/initialized":
		return mcpRespond(200, rpcResultAny(id, NewOMap()))
	default:
		return mcpRespond(200, rpcErrorOMap(id, mcpMethodNotFound, "method not found: "+method))
	}
}

// HandleMcp serves POST /mcp. malformed=true means the body was not JSON.
func HandleMcp(token string, body []byte, malformed bool) mcpResult {
	if token == "" {
		return mcpRespond(401, NewOMap().Set("message", "Bad credentials"))
	}
	if malformed {
		return mcpRespond(400, NewOMap().Set("jsonrpc", "2.0").Set("id", nil).
			Set("error", NewOMap().Set("code", mcpParseError).Set("message", "parse error: body is not JSON")))
	}
	parsed, err := parseSimpleJSON(body)
	if err != nil || parsed == nil {
		return mcpRespond(400, rpcErrorOMap(nil, mcpParseError, "parse error"))
	}
	if arr, ok := parsed.([]any); ok {
		out := make([]any, 0, len(arr))
		for _, e := range arr {
			o, _ := e.(*OMap)
			if o == nil {
				o = NewOMap()
			}
			method := bStr(o, "method")
			if method == "" {
				out = append(out, rpcErrorOMap(idOf(o), mcpMethodNotFound, "no method"))
				continue
			}
			params := NewOMap()
			if v, ok := o.Get("params"); ok {
				if m, ok := v.(*OMap); ok {
					params = m
				}
			}
			r := handleMcpRpc(method, params, idOf(o))
			// extract the body's JSON value (strip the trailing newline)
			out = append(out, mustTrimNewline(r.body))
		}
		return mcpRespond(200, out)
	}
	obj, _ := parsed.(*OMap)
	if obj == nil {
		obj = NewOMap()
	}
	method := bStr(obj, "method")
	if method == "" {
		return mcpRespond(400, rpcErrorOMap(idOf(obj), mcpParseError, "parse error: no method"))
	}
	params := NewOMap()
	if v, ok := obj.Get("params"); ok {
		if m, ok := v.(*OMap); ok {
			params = m
		}
	}
	return handleMcpRpc(method, params, idOf(obj))
}

func omProp(schema *OMap) any {
	if v, ok := schema.Get("properties"); ok {
		return v
	}
	return NewOMap()
}

func idOf(o *OMap) any {
	if v, ok := o.Get("id"); ok {
		return v
	}
	return nil
}

func mustTrimNewline(b []byte) []byte {
	if len(b) > 0 && b[len(b)-1] == '\n' {
		return b[:len(b)-1]
	}
	return b
}
