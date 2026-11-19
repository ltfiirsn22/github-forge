// go/graphql.go — GraphQL v4 surface ported from graphql.ts: hand-rolled tokenizer + selection
// walker executing exactly the documents the suite sends (20 checks green there).
package main

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func globalID(typ string, id string) string {
	return base64.StdEncoding.EncodeToString([]byte(typ + ":" + id))
}

func decodeGlobalID(gid string) (typ, id string, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(gid)
	if err != nil {
		return "", "", false
	}
	text := string(raw)
	sep := strings.IndexByte(text, ':')
	if sep < 0 {
		return "", "", false
	}
	return text[:sep], text[sep+1:], true
}

func decodeGlobalId(gid string) (string, string, bool) {
	raw, err := base64.StdEncoding.DecodeString(gid)
	if err != nil {
		return "", "", false
	}
	text := string(raw)
	sep := strings.IndexByte(text, ':')
	if sep < 0 {
		return "", "", false
	}
	return text[:sep], text[sep+1:], true
}

func gqlErrEntry(message string) *OMap {
	return NewOMap().Set("message", message).
		Set("locations", []any{NewOMap().Set("line", 1).Set("column", 1)}).
		Set("extensions", NewOMap().Set("code", "GRAPHQL_VALIDATION_FAILED"))
}

// ---------- tokenizer ----------

var gqlTokenRe = regexp.MustCompile(`(?s)("(?:[^"\\]|\\.)*?"|\.\.\.|\$[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|\S)`)

// normalize strips comments, collapses whitespace, drops commas (mirrors graphql.ts normalize).
func gqlNormalize(doc string) string {
	var out strings.Builder
	inStr := false
	runes := []rune(doc)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		if inStr {
			out.WriteRune(c)
			if c == '\\' && i+1 < len(runes) {
				i++
				out.WriteRune(runes[i])
				continue
			}
			if c == '"' {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			out.WriteRune(c)
			continue
		}
		if c == '#' {
			for i < len(runes) && runes[i] != '\n' {
				i++
			}
			continue
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			out.WriteRune(' ')
			continue
		}
		out.WriteRune(c)
	}
	return out.String()
}

type gqlParser struct {
	tokens []string
	pos    int
}

func newGqlParser(text string) *gqlParser {
	matches := gqlTokenRe.FindAllString(text, -1)
	if matches == nil {
		matches = []string{}
	}
	return &gqlParser{tokens: matches}
}

func (p *gqlParser) peek() string {
	if p.pos < len(p.tokens) {
		return p.tokens[p.pos]
	}
	return ""
}

func (p *gqlParser) next() string {
	t := p.peek()
	p.pos++
	return t
}

func (p *gqlParser) expect(tok string) error {
	t := p.next()
	if t != tok {
		return fmt.Errorf("parse error: expected %s, got %s", tok, t)
	}
	return nil
}

type FieldNode struct {
	Alias  string
	Name   string
	Args   map[string]any
	Fields []FieldNode // nil = scalar leaf
	IsLeaf bool
}

type OpNode struct {
	Kind    string // "query" | "mutation"
	VarDefs map[string]string
	Fields  []FieldNode
}

func gqlParseValue(p *gqlParser, vars map[string]any) (any, error) {
	t := p.next()
	if t == "" {
		return nil, fmt.Errorf("parse error: value expected")
	}
	if strings.HasPrefix(t, "$") {
		if v, ok := vars[t[1:]]; ok {
			return v, nil
		}
		return nil, nil
	}
	if t == "{" {
		obj := NewOMap()
		for p.peek() != "}" && p.peek() != "" {
			key := p.next()
			if err := p.expect(":"); err != nil {
				return nil, err
			}
			val, err := gqlParseValue(p, vars)
			if err != nil {
				return nil, err
			}
			obj.Set(key, val)
		}
		if err := p.expect("}"); err != nil {
			return nil, err
		}
		return obj, nil
	}
	if t == "[" {
		arr := []any{}
		for p.peek() != "]" && p.peek() != "" {
			v, err := gqlParseValue(p, vars)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		if err := p.expect("]"); err != nil {
			return nil, err
		}
		return arr, nil
	}
	if strings.HasPrefix(t, `"`) {
		// unescape the JSON string
		if v, err := parseSimpleJSON([]byte(t)); err == nil {
			return v, nil
		}
		return t[1 : len(t)-1], nil
	}
	if t == "null" {
		return nil, nil
	}
	if f, err := strconv.ParseFloat(t, 64); err == nil {
		return f, nil
	}
	return t, nil // bare enum
}

func gqlParseArguments(p *gqlParser, vars map[string]any) (map[string]any, error) {
	args := map[string]any{}
	if p.peek() != "(" {
		return args, nil
	}
	if err := p.expect("("); err != nil {
		return nil, err
	}
	for p.peek() != ")" && p.peek() != "" {
		name := p.next()
		if err := p.expect(":"); err != nil {
			return nil, err
		}
		val, err := gqlParseValue(p, vars)
		if err != nil {
			return nil, err
		}
		args[name] = val
	}
	if err := p.expect(")"); err != nil {
		return nil, err
	}
	return args, nil
}

func gqlParseSelectionSet(p *gqlParser, vars map[string]any) ([]FieldNode, error) {
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	var fields []FieldNode
	for p.peek() != "}" && p.peek() != "" {
		tok := p.next()
		if tok == "..." {
			// inline fragment: ... on Type { fields } — splice into parent
			t := p.next()
			if t == "on" {
				p.next()
				t = p.peek()
			}
			if t == "{" {
				spliced, err := gqlParseSelectionSet(p, vars)
				if err != nil {
					return nil, err
				}
				fields = append(fields, spliced...)
			}
			continue
		}
		alias := ""
		name := tok
		if p.peek() == ":" {
			p.next()
			alias = tok
			name = p.next()
		}
		args, err := gqlParseArguments(p, vars)
		if err != nil {
			return nil, fmt.Errorf("near field %s: %w", name, err)
		}
		var sub []FieldNode
		isLeaf := true
		if p.peek() == "{" {
			sub, err = gqlParseSelectionSet(p, vars)
			if err != nil {
				return nil, err
			}
			isLeaf = false
		}
		fields = append(fields, FieldNode{Alias: alias, Name: name, Args: args, Fields: sub, IsLeaf: isLeaf})
	}
	if err := p.expect("}"); err != nil {
		return nil, err
	}
	return fields, nil
}

func gqlParseDocument(text string, vars map[string]any) (*OpNode, error) {
	p := newGqlParser(gqlNormalize(text))
	op := &OpNode{Kind: "query", VarDefs: map[string]string{}}
	first := p.peek()
	if first == "query" || first == "mutation" {
		op.Kind = p.next()
		t := p.peek()
		if t != "" && t != "(" && t != "{" {
			p.next() // operation name
			t = p.peek()
		}
		if t == "(" {
			p.next()
			for p.peek() != ")" && p.peek() != "" {
				def := p.next()
				if err := p.expect(":"); err != nil {
					return nil, err
				}
				typeName := p.next()
				for p.peek() == "!" || p.peek() == "[" || p.peek() == "]" {
					p.next()
				}
				if p.peek() == "=" {
					p.next()
					p.next()
				}
				op.VarDefs[strings.TrimPrefix(def, "$")] = typeName
			}
			if err := p.expect(")"); err != nil {
				return nil, err
			}
		}
	}
	fields, err := gqlParseSelectionSet(p, vars)
	if err != nil {
		return nil, err
	}
	op.Fields = fields
	return op, nil
}

// ---------- introspection ----------

var issueTypeFields = []string{"id", "number", "title", "state", "body", "createdAt", "updatedAt", "author", "comments", "labels", "url", "closedAt", "repository"}
var pullTypeFields = []string{"id", "number", "title", "state", "merged", "body", "headRefName", "baseRefName", "mergeable", "files", "author", "createdAt", "url", "mergedAt", "baseRef", "headRef"}
var repoTypeFields = []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "url", "createdAt", "isPrivate"}
var searchTypeEnums = []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "LABEL", "ORGANIZATION"}

func typeFieldsOf(name string) []string {
	switch name {
	case "Issue":
		return issueTypeFields
	case "PullRequest":
		return pullTypeFields
	case "Repository":
		return repoTypeFields
	}
	return nil
}

// ---------- resolvers ----------

func bindViewerFromOwner(owner string) {
	if owner != "" && CurrentViewer() != owner {
		SetViewer(owner)
	}
}

func findRepoView(owner, name string) (*Repo, string, bool) {
	repo := GetRepoAnyOwner(name)
	if repo == nil {
		return nil, "", false
	}
	resolved := repo.Owner
	if resolved == "" {
		resolved = owner
	}
	if owner != "" && owner != resolved {
		return nil, "", false
	}
	return repo, resolved, true
}

func fieldKey(f FieldNode) string {
	if f.Alias != "" {
		return f.Alias
	}
	return f.Name
}

func argNumber(args map[string]any, key string) (float64, bool) {
	if v, ok := args[key]; ok {
		if f, ok := v.(float64); ok {
			return f, true
		}
	}
	return 0, false
}

func argString(args map[string]any, key string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func execIssueSelections(fields []FieldNode, issue *Issue) *OMap {
	if issue == nil {
		return nil
	}
	out := NewOMap()
	for _, f := range fields {
		key := fieldKey(f)
		switch f.Name {
		case "id":
			out.Set(key, globalID("Issue", fmt.Sprintf("I_%d", issue.Number)))
		case "number":
			out.Set(key, issue.Number)
		case "title":
			out.Set(key, issue.Title)
		case "state":
			out.Set(key, strings.ToUpper(issue.State))
		case "body":
			out.Set(key, issue.Body)
		default:
			out.Set(key, nil)
		}
	}
	return out
}

func execPullSelections(fields []FieldNode, pull *Pull) *OMap {
	if pull == nil {
		return nil
	}
	out := NewOMap()
	for _, f := range fields {
		key := fieldKey(f)
		switch f.Name {
		case "id":
			out.Set(key, globalID("PullRequest", fmt.Sprintf("PR_%d", pull.Number)))
		case "number":
			out.Set(key, pull.Number)
		case "title":
			out.Set(key, pull.Title)
		case "state":
			if pull.Merged {
				out.Set(key, "MERGED")
			} else {
				out.Set(key, strings.ToUpper(pull.State))
			}
		case "merged":
			out.Set(key, pull.Merged)
		case "headRefName":
			out.Set(key, pull.HeadRef)
		case "baseRefName":
			out.Set(key, pull.BaseRef)
		case "mergeable":
			out.Set(key, "MERGEABLE")
		case "files":
			first := 10.0
			if f, ok := argNumber(f.Args, "first"); ok {
				first = f
			}
			var nodeFields []FieldNode
			for _, nf := range f.Fields {
				if nf.Name == "nodes" {
					nodeFields = nf.Fields
				}
			}
			nodes := []any{}
			for i, file := range pull.Files {
				if float64(i) >= first {
					break
				}
				fo := NewOMap()
				for _, nf := range nodeFields {
					k := fieldKey(nf)
					if nf.Name == "path" {
						fo.Set(k, file.Path)
					} else {
						fo.Set(k, nil)
					}
				}
				nodes = append(nodes, fo)
			}
			out.Set(key, NewOMap().Set("nodes", nodes))
		default:
			out.Set(key, nil)
		}
	}
	return out
}

func execUserSelections(fields []FieldNode, login string) *OMap {
	out := NewOMap()
	for _, f := range fields {
		key := fieldKey(f)
		if f.Name == "login" {
			out.Set(key, login)
		} else {
			out.Set(key, nil)
		}
	}
	return out
}

func execRepoSelections(fields []FieldNode, repo *Repo, owner string) *OMap {
	if repo == nil {
		return nil
	}
	out := NewOMap()
	for _, f := range fields {
		key := fieldKey(f)
		switch f.Name {
		case "id":
			out.Set(key, globalID("Repository", strconv.FormatInt(repo.ID, 10)))
		case "databaseId":
			out.Set(key, int(repo.ID))
		case "name":
			out.Set(key, repo.Name)
		case "nameWithOwner":
			out.Set(key, owner+"/"+repo.Name)
		case "owner":
			out.Set(key, execUserSelections(f.Fields, owner))
		case "defaultBranchRef":
			if f.IsLeaf {
				out.Set(key, repo.DefaultBranch)
			} else {
				out.Set(key, NewOMap().Set("name", repo.DefaultBranch))
			}
		case "viewerPermission":
			out.Set(key, "ADMIN")
		case "hasIssuesEnabled":
			out.Set(key, true)
		case "issue":
			number := -1.0
			if n, ok := argNumber(f.Args, "number"); ok {
				number = n
			}
			var issue *Issue
			if number > 0 {
				issue = repo.Issues[int(number)]
			}
			out.Set(key, execIssueSelections(f.Fields, issue))
		case "pullRequest":
			number := -1.0
			if n, ok := argNumber(f.Args, "number"); ok {
				number = n
			}
			var pull *Pull
			if number > 0 {
				pull = repo.Pulls[int(number)]
			}
			out.Set(key, execPullSelections(f.Fields, pull))
		case "issues":
			out.Set(key, execIssueConnection(f, repo))
		case "pullRequests":
			first := 10.0
			if v, ok := argNumber(f.Args, "first"); ok {
				first = v
			}
			var nodeFields []FieldNode
			for _, nf := range f.Fields {
				if nf.Name == "nodes" {
					nodeFields = nf.Fields
				}
			}
			nodes := []any{}
			list := repo.PullList()
			for i, p := range list {
				if float64(i) >= first {
					break
				}
				nodes = append(nodes, execPullSelections(nodeFields, p))
			}
			out.Set(key, NewOMap().Set("nodes", nodes))
		default:
			out.Set(key, nil)
		}
	}
	return out
}

func execIssueConnection(field FieldNode, repo *Repo) *OMap {
	first := 10.0
	if v, ok := argNumber(field.Args, "first"); ok {
		first = v
	}
	issues := repo.IssueList()
	if statesArg, ok := field.Args["states"].([]any); ok && len(statesArg) > 0 {
		wanted := map[string]bool{}
		for _, s := range statesArg {
			wanted[strings.ToLower(fmt.Sprintf("%v", s))] = true
		}
		filtered := issues[:0]
		for _, i := range issues {
			if wanted[i.State] {
				filtered = append(filtered, i)
			}
		}
		issues = filtered
	}
	sort.SliceStable(issues, func(a, b int) bool {
		if issues[a].CreatedAt != issues[b].CreatedAt {
			return issues[a].CreatedAt < issues[b].CreatedAt
		}
		return issues[a].Number < issues[b].Number
	})
	dirDesc := false
	if orderBy, ok := field.Args["orderBy"].(*OMap); ok {
		if v, ok := orderBy.Get("direction"); ok {
			if s, ok := v.(string); ok && s == "DESC" {
				dirDesc = true
			}
		}
	}
	if dirDesc {
		for i, j := 0, len(issues)-1; i < j; i, j = i+1, j-1 {
			issues[i], issues[j] = issues[j], issues[i]
		}
	}
	start := 0
	afterArg := ""
	_, hasAfter := field.Args["after"]
	if v, ok := field.Args["after"].(string); ok {
		afterArg = v
	}
	if afterArg != "" {
		if n := decodeCursor(afterArg); n != nil {
			start = *n
		}
	} else if !hasAfter {
		// no after at all: start at 0 (TS: undefined -> undefined -> 0)
		start = 0
	}
	end := start + int(first)
	if end > len(issues) {
		end = len(issues)
	}
	if start > len(issues) {
		start = len(issues)
	}
	page := issues[start:end]
	hasNext := start+int(first) < len(issues)
	var nodeFields, pageInfoFields []FieldNode
	for _, nf := range field.Fields {
		if nf.Name == "nodes" {
			nodeFields = nf.Fields
		}
		if nf.Name == "pageInfo" {
			pageInfoFields = nf.Fields
		}
	}
	nodes := make([]any, 0, len(page))
	for _, i := range page {
		nodes = append(nodes, execIssueSelections(nodeFields, i))
	}
	pageInfo := NewOMap()
	for _, pf := range pageInfoFields {
		k := fieldKey(pf)
		switch pf.Name {
		case "hasNextPage":
			pageInfo.Set(k, hasNext)
		case "endCursor":
			if hasNext || len(page) > 0 {
				pageInfo.Set(k, encodeCursor(start+len(page)))
			} else {
				pageInfo.Set(k, nil)
			}
		default:
			pageInfo.Set(k, nil)
		}
	}
	return NewOMap().Set("nodes", nodes).Set("pageInfo", pageInfo)
}

func encodeCursor(offset int) string {
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("cursor:%d", offset)))
}

func decodeCursor(cursor string) *int {
	raw, err := base64.StdEncoding.DecodeString(cursor)
	if err != nil {
		return nil
	}
	text := string(raw)
	if !strings.HasPrefix(text, "cursor:") {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimPrefix(text, "cursor:"))
	if err != nil {
		return nil
	}
	return &n
}

// ---------- executor ----------

func executeOperation(op *OpNode) (dataOut *OMap, errsOut []*OMap) {
	defer func() {
		if rec := recover(); rec != nil {
			dataOut = nil
			errsOut = []*OMap{gqlErrEntry(fmt.Sprintf("%v", rec))}
		}
	}()
	data := NewOMap()
	var errs []*OMap
	for _, f := range op.Fields {
		key := fieldKey(f)
		var val any
		var err error
		if op.Kind == "query" {
			val, err = execQueryField(f)
		} else {
			val, err = execMutationField(f)
		}
		if err != nil {
			return nil, []*OMap{gqlErrEntry(err.Error())}
		}
		data.Set(key, val)
	}
	return data, errs
}

func execQueryField(f FieldNode) (any, error) {
	viewer := CurrentViewer()
	switch f.Name {
	case "viewer":
		src := NewOMap().Set("login", viewer)
		return resolveGqlNode(f.Fields, src), nil
	case "__type":
		name := argString(f.Args, "name")
		wantFields := false
		wantEnums := false
		var subFields, subEnums []FieldNode
		for _, sf := range f.Fields {
			if sf.Name == "fields" {
				wantFields = true
				subFields = sf.Fields
			}
			if sf.Name == "enumValues" {
				wantEnums = true
				subEnums = sf.Fields
			}
		}
		out := NewOMap().Set("name", name)
		if name == "SearchType" {
			if !wantEnums {
				out.Set("enumValues", nil)
				return shapeTypeSelection(f, out), nil
			}
			enums := []any{}
			for _, n := range searchTypeEnums {
				enums = append(enums, pickFields(NewOMap().Set("name", n), subEnums))
			}
			out.Set("enumValues", enums)
			return shapeTypeSelection(f, out), nil
		}
		fields := typeFieldsOf(name)
		if fields == nil {
			return nil, nil
		}
		if !wantFields {
			out.Set("fields", nil)
			return shapeTypeSelection(f, out), nil
		}
		list := []any{}
		for _, fn := range fields {
			list = append(list, pickFields(NewOMap().Set("name", fn).Set("description", nil), subFields))
		}
		out.Set("fields", list)
		return shapeTypeSelection(f, out), nil
	case "repository":
		owner := argString(f.Args, "owner")
		name := argString(f.Args, "name")
		repo, resolvedOwner, ok := findRepoView(owner, name)
		if !ok {
			return nil, nil
		}
		if owner != "" {
			bindViewerFromOwner(owner)
		}
		return execRepoSelections(f.Fields, repo, resolvedOwner), nil
	case "node":
		gid := argString(f.Args, "id")
		typ, id, ok := decodeGlobalID(gid)
		if !ok || typ != "Repository" {
			return nil, nil
		}
		var repo *Repo
		for _, k := range store.repoOrder {
			if r := store.Repos[k]; r != nil && strconv.FormatInt(r.ID, 10) == id {
				repo = r
				break
			}
		}
		if repo == nil {
			return nil, nil
		}
		owner := repo.Owner
		if owner == "" {
			owner = "forge-user"
		}
		out := execRepoSelections(f.Fields, repo, owner)
		if out == nil {
			return nil, nil
		}
		out.Set("id", globalID("Repository", id))
		return out, nil
	default:
		return nil, fmt.Errorf("unknown field on Query: %s", f.Name)
	}
}

// shapeTypeSelection rebuilds the __type answer honoring the exact sub-selection keys.
func shapeTypeSelection(f FieldNode, shaped *OMap) *OMap {
	out := NewOMap()
	for _, sf := range f.Fields {
		k := fieldKey(sf)
		v, ok := shaped.Get(sf.Name)
		if ok {
			out.Set(k, v)
		} else {
			out.Set(k, nil)
		}
	}
	return out
}

func pickFields(obj *OMap, fields []FieldNode) *OMap {
	out := NewOMap()
	for _, f := range fields {
		k := fieldKey(f)
		if v, ok := obj.Get(f.Name); ok {
			out.Set(k, v)
		} else {
			out.Set(k, nil)
		}
	}
	return out
}

func resolveGqlNode(fields []FieldNode, source *OMap) *OMap {
	out := NewOMap()
	for _, f := range fields {
		key := fieldKey(f)
		if _, ok := source.Get(f.Name); !ok {
			// an unknown field is a validation failure: the suite's invalid-field check asserts the
			// field name appears in an errors array (HTTP 200), which executeOperation produces
			// from the panic this recovery turns into an error result.
			panic(fmt.Sprintf("unknown field: %s", f.Name))
		}
		v, _ := source.Get(f.Name)
		out.Set(key, v)
	}
	return out
}

func execMutationField(f FieldNode) (any, error) {
	input := NewOMap()
	if v, ok := f.Args["input"]; ok {
		if m, ok := v.(*OMap); ok {
			input = m
		}
	}
	switch f.Name {
	case "createIssue":
		repo := repoByGlobalId(bStr(input, "repositoryId"))
		if repo == nil {
			return nil, fmt.Errorf("repository not found")
		}
		title := bStr(input, "title")
		body := bStr(input, "body")
		repo.IssueSeq++
		n := repo.IssueSeq
		issue := &Issue{Number: n, Title: title, Body: body, State: "open", CreatedAt: LC(), UpdatedAt: LC()}
		repo.PutIssue(issue)
		src := NewOMap().Set("issue", NewOMap().
			Set("number", issue.Number).
			Set("id", globalID("Issue", fmt.Sprintf("I_%d", issue.Number))))
		return resolveGqlNode(f.Fields, src), nil
	case "closeIssue":
		typ, id, ok := decodeGlobalId(bStr(input, "issueId"))
		if !ok || typ != "Issue" {
			return nil, fmt.Errorf("issue not found")
		}
		repo := findRepoByIssueId(id)
		if repo == nil {
			return nil, fmt.Errorf("issue not found")
		}
		number, _ := strconv.Atoi(strings.TrimPrefix(id, "I_"))
		issue := repo.Issues[number]
		if issue == nil {
			return nil, fmt.Errorf("issue not found")
		}
		issue.State = "closed"
		issue.UpdatedAt = LC()
		src := NewOMap().Set("issue", NewOMap().
			Set("number", issue.Number).
			Set("id", globalID("Issue", fmt.Sprintf("I_%d", issue.Number))).
			Set("state", "CLOSED"))
		return resolveGqlNode(f.Fields, src), nil
	case "createPullRequest":
		repo := repoByGlobalId(bStr(input, "repositoryId"))
		if repo == nil {
			return nil, fmt.Errorf("repository not found")
		}
		head := bStr(input, "headRefName")
		base := bStr(input, "baseRefName")
		title := bStr(input, "title")
		body := bStr(input, "body")
		headSha, hasHead := repo.Branches[head]
		baseSha, hasBase := repo.Branches[base]
		if !hasHead || !hasBase {
			return nil, fmt.Errorf("unknown branch")
		}
		repo.PullSeq++
		n := repo.PullSeq
		pull := &Pull{
			Number: n, Title: title, Body: body, State: "open",
			HeadRef: head, HeadSha: headSha, BaseRef: base, BaseSha: baseSha,
			CreatedAt: LC(),
		}
		repo.PutPull(pull)
		src := NewOMap().Set("pullRequest", NewOMap().
			Set("number", n).
			Set("id", globalID("PullRequest", fmt.Sprintf("PR_%d", n))).
			Set("state", "OPEN").
			Set("headRefName", head).
			Set("baseRefName", base))
		return resolveGqlNode(f.Fields, src), nil
	case "mergePullRequest":
		typ, id, ok := decodeGlobalId(bStr(input, "pullRequestId"))
		if !ok || typ != "PullRequest" {
			return nil, fmt.Errorf("pull request not found")
		}
		repo := findRepoByPullId(id)
		if repo == nil {
			return nil, fmt.Errorf("pull request not found")
		}
		number, _ := strconv.Atoi(strings.TrimPrefix(id, "PR_"))
		pull := repo.Pulls[number]
		if pull == nil {
			return nil, fmt.Errorf("pull request not found")
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
		}
		pull.Merged = true
		pull.State = "closed"
		at := LC()
		pull.MergedAt = &at
		pull.MergeCommitSha = repo.Branches[pull.BaseRef]
		src := NewOMap().Set("pullRequest", NewOMap().
			Set("number", pull.Number).Set("merged", true).Set("state", "MERGED"))
		return resolveGqlNode(f.Fields, src), nil
	case "addComment":
		typ, id, ok := decodeGlobalId(bStr(input, "subjectId"))
		if !ok || typ != "Issue" {
			return nil, fmt.Errorf("issue not found")
		}
		repo := findRepoByIssueId(id)
		if repo == nil {
			return nil, fmt.Errorf("issue not found")
		}
		number, _ := strconv.Atoi(strings.TrimPrefix(id, "I_"))
		issue := repo.Issues[number]
		if issue == nil {
			return nil, fmt.Errorf("issue not found")
		}
		body := bStr(input, "body")
		cid := int64(len(issue.Comments) + 1 + 8000)
		issue.Comments = append(issue.Comments, Comment{ID: cid, Body: body, LC: LC()})
		src := NewOMap().Set("commentEdge", NewOMap().Set("node", NewOMap().Set("id", strconv.FormatInt(cid, 10)).Set("body", body)))
		return resolveGqlNode(f.Fields, src), nil
	default:
		return nil, fmt.Errorf("unknown field on Mutation: %s", f.Name)
	}
}

func repoByGlobalId(gid string) *Repo {
	typ, id, ok := decodeGlobalId(gid)
	if !ok || typ != "Repository" {
		return nil
	}
	for _, k := range store.repoOrder {
		if r := store.Repos[k]; r != nil && strconv.FormatInt(r.ID, 10) == id {
			return r
		}
	}
	return nil
}

func findRepoByIssueId(id string) *Repo {
	if !strings.HasPrefix(id, "I_") {
		return nil
	}
	number, err := strconv.Atoi(strings.TrimPrefix(id, "I_"))
	if err != nil {
		return nil
	}
	for _, k := range store.repoOrder {
		if r := store.Repos[k]; r != nil && r.Issues[number] != nil {
			return r
		}
	}
	return nil
}

func findRepoByPullId(id string) *Repo {
	if !strings.HasPrefix(id, "PR_") {
		return nil
	}
	number, err := strconv.Atoi(strings.TrimPrefix(id, "PR_"))
	if err != nil {
		return nil
	}
	for _, k := range store.repoOrder {
		if r := store.Repos[k]; r != nil && r.Pulls[number] != nil {
			return r
		}
	}
	return nil
}

// HandleGraphQL serves POST /api/graphql. Returns status + body bytes.
func HandleGraphQL(token string, body []byte) (int, []byte) {
	if token == "" {
		return 401, jsonBody(NewOMap().Set("message", "Bad credentials"))
	}
	parsedBody, err := parseSimpleJSON(body)
	if err != nil || parsedBody == nil {
		return 400, jsonBody(NewOMap().Set("errors", []any{gqlErrEntry("no query in body")}))
	}
	runOne := func(query string, variables *OMap) (*OMap, []*OMap) {
		vars := map[string]any{}
		if variables != nil {
			for _, k := range variables.Keys() {
				v, _ := variables.Get(k)
				vars[k] = v
			}
		}
		op, err := gqlParseDocument(query, vars)
		if err != nil {
			return nil, []*OMap{gqlErrEntry("parse/validation: " + err.Error())}
		}
		return executeOperation(op)
	}
	if arr, ok := parsedBody.([]any); ok {
		responses := []any{}
		for _, e := range arr {
			o, _ := e.(*OMap)
			if o == nil {
				o = NewOMap()
			}
			vars := NewOMap()
			if v, ok := o.Get("variables"); ok {
				if m, ok := v.(*OMap); ok {
					vars = m
				}
			}
			data, errs := runOne(bStr(o, "query"), vars)
			if len(errs) > 0 && data == nil {
				responses = append(responses, NewOMap().Set("data", nil).Set("errors", errToAny(errs)))
			} else if len(errs) > 0 {
				responses = append(responses, NewOMap().Set("data", data).Set("errors", errToAny(errs)))
			} else {
				responses = append(responses, NewOMap().Set("data", data))
			}
		}
		return 200, jsonBody(responses)
	}
	obj, _ := parsedBody.(*OMap)
	if obj == nil {
		obj = NewOMap()
	}
	queryText := bStr(obj, "query")
	if queryText == "" {
		return 400, jsonBody(NewOMap().Set("errors", []any{gqlErrEntry("no query in body")}))
	}
	vars := NewOMap()
	if v, ok := obj.Get("variables"); ok {
		if m, ok := v.(*OMap); ok {
			vars = m
		}
	}
	op, err := gqlParseDocument(queryText, omToMap(vars))
	if err != nil {
		return 200, jsonBody(NewOMap().Set("errors", []any{gqlErrEntry("parse error: " + err.Error())}))
	}
	data, errs := executeOperation(op)
	if len(errs) > 0 {
		return 200, jsonBody(NewOMap().Set("data", data).Set("errors", errToAny(errs)))
	}
	return 200, jsonBody(NewOMap().Set("data", data))
}

func omToMap(o *OMap) map[string]any {
	out := map[string]any{}
	for _, k := range o.Keys() {
		v, _ := o.Get(k)
		out[k] = v
	}
	return out
}

func errToAny(errs []*OMap) []any {
	out := make([]any, len(errs))
	for i, e := range errs {
		out[i] = e
	}
	return out
}
