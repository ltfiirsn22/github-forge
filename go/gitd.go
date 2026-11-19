// go/gitd.go — git smart-HTTP surface ported from gitd.ts: info/refs advertisement (v2 + v0),
// v2 ls-refs/fetch, v0 fetch, receive-pack with report-status + side-band-64k, honest objects.
package main

import (
	"bytes"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ---------- pkt-line ----------

func pkt(s string) []byte {
	b := []byte(s)
	out := make([]byte, 4, 4+len(b))
	hexLen := strconv.FormatInt(int64(len(b)+4), 16)
	for len(hexLen) < 4 {
		hexLen = "0" + hexLen
	}
	copy(out, hexLen)
	return append(out, b...)
}

func pktBytes(b []byte) []byte {
	out := make([]byte, 4, 4+len(b))
	hexLen := strconv.FormatInt(int64(len(b)+4), 16)
	for len(hexLen) < 4 {
		hexLen = "0" + hexLen
	}
	copy(out, hexLen)
	return append(out, b...)
}

var flushPkt = []byte("0000")
var delimPkt = []byte("0001")

func sideband1(data []byte) []byte {
	const chunk = 65515
	var out []byte
	if len(data) == 0 {
		return pktBytes([]byte{1})
	}
	for off := 0; off < len(data); off += chunk {
		end := off + chunk
		if end > len(data) {
			end = len(data)
		}
		frame := make([]byte, 0, end-off+1)
		frame = append(frame, 1)
		frame = append(frame, data[off:end]...)
		out = append(out, pktBytes(frame)...)
	}
	return out
}

type pktPacket struct {
	kind    byte // 'd' data, 'f' flush, 'm' delim
	payload []byte
}

// decodePackets decodes a whole pkt-line buffer at once.
func decodePackets(b []byte) ([]pktPacket, error) {
	var out []pktPacket
	for len(b) >= 4 {
		hex := string(b[:4])
		n, err := strconv.ParseInt(hex, 16, 32)
		if err != nil {
			return nil, errInvalidPkt("bad pkt-line length prefix " + hex)
		}
		if n == 0 {
			out = append(out, pktPacket{kind: 'f'})
			b = b[4:]
			continue
		}
		if n == 1 {
			out = append(out, pktPacket{kind: 'm'})
			b = b[4:]
			continue
		}
		if n < 4 || int(n) > len(b) {
			return nil, errInvalidPkt("bad pkt-line length")
		}
		out = append(out, pktPacket{kind: 'd', payload: b[4:n]})
		b = b[n:]
	}
	if len(b) > 0 {
		return nil, errInvalidPkt("trailing bytes after pkt stream")
	}
	return out, nil
}

type wireErr string

func (e wireErr) Error() string { return string(e) }

func errInvalidPkt(msg string) error { return wireErr(msg) }

// ---------- refs ----------

type RefEntry struct {
	Name   string
	OID    string
	Peeled string
	Symref string
}

func refList(repo *Repo) []RefEntry {
	if repo.RefGen > 0 && repo.RefListCache != nil && len(repo.RefListCache) > 0 && repo.refCacheGen == repo.RefGen {
		return repo.RefListCache
	}
	var refs []RefEntry
	headSha, hasHead := repo.Branches[repo.DefaultBranch]
	if hasHead {
		refs = append(refs, RefEntry{Name: "HEAD", OID: headSha, Symref: "refs/heads/" + repo.DefaultBranch})
	}
	for _, n := range repo.BranchNames() {
		refs = append(refs, RefEntry{Name: "refs/heads/" + n, OID: repo.Branches[n]})
	}
	for _, pair := range repo.TagPairs() {
		name, oid := pair[0], pair[1]
		e := RefEntry{Name: "refs/tags/" + name, OID: oid}
		if peeled := peelTag(repo, oid); peeled != "" {
			e.Peeled = peeled
		}
		refs = append(refs, e)
	}
	repo.refCacheGen = repo.RefGen
	repo.RefListCache = refs
	return refs
}

func peelTag(repo *Repo, tagOID string) string {
	if obj, ok := repo.TagObjects[tagOID]; ok {
		text := string(obj.Data)
		m := reTagObject.FindStringSubmatch(text)
		if m != nil {
			return m[1]
		}
	}
	return ""
}

var reTagObject = regexp.MustCompile(`(?m)^object ([0-9a-f]{40})`)

var uploadPackV2Caps = []string{
	"agent=forge/1.0",
	"ls-refs=unborn",
	"fetch=shallow wait-for-done filter",
	"server-option",
	"object-format=sha1",
}

func advertiseUploadPackV2() []byte {
	var out []byte
	out = append(out, pkt("version 2\n")...)
	for _, c := range uploadPackV2Caps {
		out = append(out, pkt(c+"\n")...)
	}
	out = append(out, flushPkt...)
	return out
}

const v0UploadCaps = "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 agent=forge/1.0"
const v0ReceiveCaps = "report-status report-status-v2 delete-refs side-band-64k ofs-delta atomic object-format=sha1 quiet agent=forge/1.0"

func advertiseV0(service string, repo *Repo) []byte {
	caps := v0UploadCaps
	if service == "git-receive-pack" {
		caps = v0ReceiveCaps
	}
	var out []byte
	out = append(out, pkt("# service="+service+"\n")...)
	out = append(out, flushPkt...)
	var refs []RefEntry
	if repo != nil {
		refs = refList(repo)
	}
	if len(refs) == 0 {
		out = append(out, pkt("0000000000000000000000000000000000000000 capabilities^{}\x00"+caps+"\n")...)
	} else {
		for i, r := range refs {
			line := r.OID + " " + r.Name
			if i == 0 {
				extra := []string{caps}
				if r.Symref != "" {
					extra = append([]string{"symref=HEAD:" + r.Symref}, extra...)
				}
				extra = append(extra, "peel")
				line += "\x00" + strings.Join(extra, " ")
			}
			out = append(out, pkt(line+"\n")...)
			if r.Peeled != "" {
				out = append(out, pkt(r.Peeled+" "+r.Name+"^{}\n")...)
			}
		}
	}
	out = append(out, flushPkt...)
	return out
}

// ---------- ls-refs ----------

func lsRefs(repo *Repo, args []string) []byte {
	symrefs := containsStr(args, "symrefs")
	peel := containsStr(args, "peel")
	var prefixes []string
	for _, a := range args {
		if strings.HasPrefix(a, "ref-prefix ") {
			prefixes = append(prefixes, strings.TrimPrefix(a, "ref-prefix "))
		}
	}
	var out []byte
	for _, r := range refList(repo) {
		if len(prefixes) > 0 {
			matched := false
			for _, p := range prefixes {
				if strings.HasPrefix(r.Name, p) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		line := r.OID + " " + r.Name
		if symrefs && r.Symref != "" {
			line += " symref-target:" + r.Symref
		}
		if peel && r.Peeled != "" {
			line += " peeled:" + r.Peeled
		}
		out = append(out, pkt(line+"\n")...)
	}
	out = append(out, flushPkt...)
	return out
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ---------- honest objects (REST-created content) ----------

// HonestBlob stores blob content and returns its honest git blob oid.
func HonestBlob(repo *Repo, content string) string {
	obj := MakeObject(ObjBlob, []byte(content))
	repo.BlobStore[obj.OID] = content
	return obj.OID
}

// honestCommitTree builds a nested tree from the flat path->blobOid map, stores every tree's
// raw bytes, and returns the root tree oid.
func honestCommitTree(repo *Repo, flatTree map[string]string) string {
	type node struct {
		sub  map[string]*node
		leaf string
	}
	root := &node{sub: make(map[string]*node)}
	for path, oid := range flatTree {
		segs := strings.Split(path, "/")
		cur := root
		for i := 0; i < len(segs)-1; i++ {
			next, ok := cur.sub[segs[i]]
			if !ok || next.leaf != "" {
				next = &node{sub: make(map[string]*node)}
				cur.sub[segs[i]] = next
			}
			cur = next
		}
		cur.sub[segs[len(segs)-1]] = &node{sub: make(map[string]*node), leaf: oid}
	}
	var writeTree func(n *node) string
	writeTree = func(n *node) string {
		names := make([]string, 0, len(n.sub))
		for name := range n.sub {
			names = append(names, name)
		}
		sort.Strings(names)
		entries := make([]TreeEnt, 0, len(names))
		for _, name := range names {
			child := n.sub[name]
			if child.leaf != "" {
				entries = append(entries, TreeEnt{Mode: "100644", Name: name, OID: child.leaf})
			} else {
				entries = append(entries, TreeEnt{Mode: "40000", Name: name, OID: writeTree(child)})
			}
		}
		raw := SerializeTree(entries)
		obj := MakeObject(ObjTree, raw)
		repo.TreeRaws[obj.OID] = raw
		return obj.OID
	}
	return writeTree(root)
}

// HonestCommit creates a commit with a REAL nested tree. Returns the commit oid.
func HonestCommit(repo *Repo, flatTree map[string]string, parents []string, message string) string {
	rootOID := honestCommitTree(repo, flatTree)
	raw := SerializeCommit(rootOID, parents, "forge <forge@local> 1760000000 +0000", "forge <forge@local> 1760000000 +0000", message)
	obj := MakeObject(ObjCommit, raw)
	repo.CommitRaws[obj.OID] = raw
	repo.PutCommit(&CommitNode{Sha: obj.OID, Message: message, Tree: flatTree, Parents: parents, LC: LC()})
	return obj.OID
}

// commitRaw returns the exact original bytes for a pushed commit or reconstructs them.
func commitRaw(repo *Repo, sha string) []byte {
	if raw, ok := repo.CommitRaws[sha]; ok {
		return raw
	}
	if c, ok := repo.Commits[sha]; ok {
		rootOID := honestCommitTree(repo, c.Tree)
		return SerializeCommit(rootOID, c.Parents, "forge <forge@local> 1760000000 +0000", "forge <forge@local> 1760000000 +0000", c.Message)
	}
	return nil
}

// objectsForCommit collects a commit + its trees + blobs (ORIGINAL bytes where stored).
func objectsForCommit(repo *Repo, sha string, out map[string]*GitObj) {
	if _, done := out[sha]; done {
		return
	}
	raw := commitRaw(repo, sha)
	if raw == nil {
		return
	}
	obj := MakeObject(ObjCommit, raw)
	out[obj.OID] = obj
	node, ok := repo.Commits[sha]
	if !ok {
		return
	}
	parsed := ParseCommit(raw)
	var emitTree func(treeOID string)
	emitTree = func(treeOID string) {
		rawTree, hasRaw := repo.TreeRaws[treeOID]
		var entries []TreeEnt
		if hasRaw {
			entries = ParseTree(rawTree)
		} else {
			// rebuild from the flat tree
			for p, oid := range node.Tree {
				mode := "100644"
				if strings.Contains(p, "/") {
					mode = "40000"
				}
				entries = append(entries, TreeEnt{Mode: mode, Name: p, OID: oid})
			}
			sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
			rawTree = SerializeTree(entries)
		}
		t := MakeObject(ObjTree, rawTree)
		out[t.OID] = t
		for _, ent := range entries {
			if ent.Mode == "40000" || ent.Mode == "040000" {
				if sub, ok := repo.TreeRaws[ent.OID]; ok {
					subObj := MakeObject(ObjTree, sub)
					out[subObj.OID] = subObj
					for _, e2 := range ParseTree(sub) {
						if e2.Mode == "40000" || e2.Mode == "040000" {
							emitTree(e2.OID)
						} else if _, seen := out[e2.OID]; !seen {
							content := repo.BlobStore[e2.OID]
							out[e2.OID] = MakeObject(ObjBlob, []byte(content))
						}
					}
				}
			} else if _, seen := out[ent.OID]; !seen {
				content := repo.BlobStore[ent.OID]
				out[ent.OID] = MakeObject(ObjBlob, []byte(content))
			}
		}
	}
	emitTree(parsed.Tree)
}

// levelsFromTip BFS-walks ancestry with depth labels, bounded by maxDepth.
func levelsFromTip(repo *Repo, tip string, haves map[string]bool, maxDepth int) [][2]string {
	var out [][2]string
	visited := map[string]bool{}
	frontier := []string{tip}
	depth := 1
	for len(frontier) > 0 && depth <= maxDepth {
		var next []string
		for _, sha := range frontier {
			if visited[sha] {
				continue
			}
			visited[sha] = true
			out = append(out, [2]string{sha, strconv.Itoa(depth)})
			if haves[sha] {
				continue
			}
			c, ok := repo.Commits[sha]
			if !ok {
				continue
			}
			for _, p := range c.Parents {
				if !visited[p] {
					next = append(next, p)
				}
			}
		}
		frontier = next
		depth++
	}
	return out
}

// collectObjects gathers objects for wants, minus what the client already holds.
func collectObjects(repo *Repo, tips []string, haves map[string]bool, shallow map[string]bool, deepen int) (map[string]*GitObj, []string) {
	objs := make(map[string]*GitObj)
	var shallowLines []string
	heldObjects := map[string]bool{}
	for have := range haves {
		if _, ok := repo.Commits[have]; !ok {
			continue
		}
		haveObjs := make(map[string]*GitObj)
		objectsForCommit(repo, have, haveObjs)
		for oid := range haveObjs {
			heldObjects[oid] = true
		}
	}
	tagByOid := make(map[string]string)
	for _, pair := range repo.TagPairs() {
		tagByOid[pair[1]] = pair[0]
	}
	var deliveredTags []*GitObj
	const maxInt = int(^uint(0) >> 1)
	for _, tip := range tips {
		_, isTag := tagByOid[tip]
		tagObj := repo.TagObjects[tip]
		if isTag && tagObj != nil {
			deliveredTags = append(deliveredTags, tagObj)
		}
		_, hasCommit := repo.Commits[tip]
		if !hasCommit && tagObj == nil {
			continue
		}
		maxDepth := maxInt
		if deepen > 0 {
			maxDepth = deepen
		}
		levels := levelsFromTip(repo, tip, map[string]bool{}, maxDepth)
		for _, pair := range levels {
			sha, depth := pair[0], pair[1]
			d, _ := strconv.Atoi(depth)
			if d > maxDepth {
				continue
			}
			if haves[sha] {
				continue
			}
			objectsForCommit(repo, sha, objs)
		}
		if deepen > 0 {
			for _, pair := range levels {
				sha, depth := pair[0], pair[1]
				d, _ := strconv.Atoi(depth)
				if d == deepen && !shallow[sha] {
					shallowLines = append(shallowLines, "shallow "+sha+"\n")
				}
			}
		}
	}
	for oid := range heldObjects {
		delete(objs, oid)
	}
	for _, t := range deliveredTags {
		if !heldObjects[t.OID] {
			objs[t.OID] = t
		}
	}
	return objs, shallowLines
}

// ---------- fetch v2 ----------

func handleFetchV2(repo *Repo, args []string) []byte {
	var wants, haves, shallow []string
	deepen := 0
	done := false
	for _, a := range args {
		switch {
		case strings.HasPrefix(a, "want "):
			wants = append(wants, strings.TrimPrefix(a, "want "))
		case strings.HasPrefix(a, "have "):
			haves = append(haves, strings.TrimPrefix(a, "have "))
		case strings.HasPrefix(a, "shallow "):
			shallow = append(shallow, strings.TrimPrefix(a, "shallow "))
		case strings.HasPrefix(a, "deepen "):
			deepen, _ = strconv.Atoi(strings.TrimPrefix(a, "deepen "))
		case a == "done":
			done = true
		}
	}
	haveSet := make(map[string]bool)
	for _, h := range haves {
		haveSet[h] = true
	}
	shallowSet := make(map[string]bool)
	for _, s := range shallow {
		shallowSet[s] = true
	}
	objs, shallowLines := collectObjects(repo, wants, haveSet, shallowSet, deepen)

	// pack cache keyed by request signature (cleared on every ref change)
	sorted := func(list []string) string {
		c := append([]string(nil), list...)
		sort.Strings(c)
		return strings.Join(c, ",")
	}
	oids := make([]string, 0, len(objs))
	for oid := range objs {
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	cacheKey := sorted(wants) + "|" + sorted(haves) + "|" + strconv.Itoa(deepen) + "|" + strings.Join(oids, ",")
	pack, cached := repo.PackCache[cacheKey]
	if !cached {
		list := make([]*GitObj, 0, len(objs))
		for _, oid := range oids { // sorted: deterministic
			list = append(list, objs[oid])
		}
		pack = WritePack(list)
		if len(repo.PackCache) < 64 {
			repo.PackCache[cacheKey] = pack
		}
	}
	var sections []byte
	if !done {
		var acks []byte
		acks = append(acks, pkt("acknowledgments\n")...)
		if len(haves) == 0 {
			acks = append(acks, pkt("NAK\n")...)
		} else {
			for _, h := range haves {
				if _, ok := repo.Commits[h]; ok {
					acks = append(acks, pkt("ACK "+h+"\n")...)
				}
			}
		}
		sections = append(sections, acks...)
		sections = append(sections, delimPkt...)
	}
	if len(shallowLines) > 0 {
		sections = append(sections, pkt("shallow-info\n")...)
		for _, l := range shallowLines {
			sections = append(sections, pkt(l)...)
		}
		sections = append(sections, delimPkt...)
	}
	sections = append(sections, pkt("packfile\n")...)
	sections = append(sections, sideband1(pack)...)
	sections = append(sections, flushPkt...)
	return sections
}

// ---------- fetch v0 ----------

func handleFetchV0(repo *Repo, body []byte) []byte {
	packets, err := decodePackets(body)
	if err != nil {
		return append(pkt("ERR "+err.Error()+"\n"), flushPkt...)
	}
	var wants, haves, shallow []string
	deepen := 0
	caps := ""
	done := false
	inWantSection := true
	for _, p := range packets {
		if p.kind == 'f' {
			inWantSection = false
			continue
		}
		if p.kind != 'd' {
			continue
		}
		line := strings.TrimSuffix(string(p.payload), "\n")
		if inWantSection {
			clean := line
			if nul := strings.IndexByte(line, 0); nul >= 0 {
				caps = line[nul+1:]
				clean = line[:nul]
			}
			if strings.HasPrefix(clean, "want ") {
				wants = append(wants, strings.Fields(clean[5:])[0])
			} else if strings.HasPrefix(clean, "shallow ") {
				shallow = append(shallow, strings.TrimPrefix(clean, "shallow "))
			} else if strings.HasPrefix(clean, "deepen ") {
				deepen, _ = strconv.Atoi(strings.TrimPrefix(clean, "deepen "))
			}
		} else {
			if strings.HasPrefix(line, "have ") {
				haves = append(haves, strings.TrimPrefix(line, "have "))
			} else if line == "done" {
				done = true
			}
		}
	}
	haveSet := make(map[string]bool)
	for _, h := range haves {
		haveSet[h] = true
	}
	shallowSet := make(map[string]bool)
	for _, s := range shallow {
		shallowSet[s] = true
	}
	objs, shallowLines := collectObjects(repo, wants, haveSet, shallowSet, deepen)

	sideband := strings.Contains(caps, "side-band-64k") || strings.Contains(caps, "side-band")
	var parts []byte
	if !done {
		parts = append(parts, pkt("NAK\n")...)
		parts = append(parts, flushPkt...)
		return parts
	}
	if len(haves) > 0 && strings.Contains(caps, "multi_ack_detailed") {
		for _, h := range haves {
			if _, ok := repo.Commits[h]; ok {
				parts = append(parts, pkt("ACK "+h+" common\n")...)
			}
		}
	}
	for _, line := range shallowLines {
		parts = append(parts, pkt(line)...)
	}
	parts = append(parts, pkt("NAK\n")...)
	oids := make([]string, 0, len(objs))
	for oid := range objs {
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	list := make([]*GitObj, 0, len(objs))
	for _, oid := range oids {
		list = append(list, objs[oid])
	}
	pack := WritePack(list)
	if sideband {
		parts = append(parts, sideband1(pack)...)
		parts = append(parts, flushPkt...)
	} else {
		parts = append(parts, pack...)
	}
	return parts
}

// ---------- receive-pack ----------

type pushCommand struct {
	oldOid string
	newOid string
	ref    string
}

var rePushCmd = regexp.MustCompile(`^([0-9a-f]{40}) ([0-9a-f]{40}) (refs/\S+)$`)

func handleReceivePack(repo *Repo, body []byte) []byte {
	var commands []pushCommand
	caps := ""
	seenCommands := false
	var packStart int // assigned on every path below; the init was ineffectual
	{
		off := 0
		for off+4 <= len(body) {
			hex := string(body[off : off+4])
			n, err := strconv.ParseInt(hex, 16, 32)
			if err != nil {
				break // non-pkt data: the pack
			}
			if n < 4 { // flush: commands done
				off += 4
				seenCommands = true
				break
			}
			if off+int(n) > len(body) {
				break // partial pkt: malformed
			}
			line := strings.TrimSuffix(string(body[off+4:off+int(n)]), "\n")
			off += int(n)
			clean := line
			if nul := strings.IndexByte(line, 0); nul >= 0 {
				caps = line[nul+1:]
				clean = line[:nul]
			}
			if m := rePushCmd.FindStringSubmatch(clean); m != nil {
				commands = append(commands, pushCommand{m[1], m[2], m[3]})
			}
		}
		if off+4 <= len(body) {
			if n, err := strconv.ParseInt(string(body[off:off+4]), 16, 32); err == nil && n == 0 {
				seenCommands = true
				packStart = off + 4
			} else {
				packStart = off
			}
		} else {
			packStart = off
		}
	}

	type refResult struct {
		ref    string
		ok     bool
		reason string
	}
	var results []refResult
	unpackOk := true
	unpackErr := ""
	objects := make(map[string]*GitObj)

	anyCreateUpdate := false
	for _, c := range commands {
		if c.newOid != "0000000000000000000000000000000000000000" {
			anyCreateUpdate = true
			break
		}
	}
	var packBytes []byte
	if seenCommands && anyCreateUpdate {
		packBytes = body[packStart:]
	}
	if len(packBytes) > 0 {
		read, err := ReadPack(packBytes, nil)
		if err != nil {
			unpackOk = false
			unpackErr = err.Error()
		} else {
			objects = read
		}
	}

	if unpackOk {
		for _, cmd := range commands {
			zero := "0000000000000000000000000000000000000000"
			if cmd.newOid == zero {
				// delete
				switch {
				case strings.HasPrefix(cmd.ref, "refs/heads/"):
					delete(repo.Branches, strings.TrimPrefix(cmd.ref, "refs/heads/"))
					invalidateRefCaches(repo)
					results = append(results, refResult{cmd.ref, true, ""})
				case strings.HasPrefix(cmd.ref, "refs/tags/"):
					delete(repo.Tags, strings.TrimPrefix(cmd.ref, "refs/tags/"))
					invalidateRefCaches(repo)
					results = append(results, refResult{cmd.ref, true, ""})
				case cmd.ref == "HEAD":
					results = append(results, refResult{cmd.ref, false, "refusing to delete the current branch"})
				default:
					results = append(results, refResult{cmd.ref, false, "deletion not allowed here"})
				}
				continue
			}
			if _, ok := objects[cmd.newOid]; !ok {
				if _, inStore := repo.Commits[cmd.newOid]; !inStore {
					results = append(results, refResult{cmd.ref, false, "missing necessary objects"})
					continue
				}
			}
			if cmd.oldOid != zero {
				var cur string
				var hasCur bool
				if strings.HasPrefix(cmd.ref, "refs/heads/") {
					cur, hasCur = repo.Branches[strings.TrimPrefix(cmd.ref, "refs/heads/")]
				} else {
					cur, hasCur = repo.Tags[strings.TrimPrefix(cmd.ref, "refs/tags/")]
				}
				if hasCur && cur != cmd.oldOid {
					results = append(results, refResult{cmd.ref, false, "fetch first"})
					continue
				}
				if hasCur && !isAncestor(repo, cmd.oldOid, cmd.newOid, objects) {
					results = append(results, refResult{cmd.ref, false, "non-fast-forward"})
					continue
				}
			}
			absorbObjects(repo, objects)
			if strings.HasPrefix(cmd.ref, "refs/heads/") {
				repo.Branches[strings.TrimPrefix(cmd.ref, "refs/heads/")] = cmd.newOid
			} else if strings.HasPrefix(cmd.ref, "refs/tags/") {
				name := strings.TrimPrefix(cmd.ref, "refs/tags/")
				if _, exists := repo.Tags[name]; !exists {
					repo.tagOrder = append(repo.tagOrder, name)
				}
				repo.Tags[name] = cmd.newOid
			} else if cmd.ref == "HEAD" {
				repo.Branches[repo.DefaultBranch] = cmd.newOid
			}
			invalidateRefCaches(repo)
			results = append(results, refResult{cmd.ref, true, ""})
		}
	} else {
		for _, cmd := range commands {
			results = append(results, refResult{cmd.ref, false, "unpack failed: " + unpackErr})
		}
	}

	// absorb blobs for any pushed commit
	for _, obj := range objects {
		if obj.Type == ObjBlob {
			repo.BlobStore[obj.OID] = string(obj.Data)
		}
	}

	// report-status, side-band wrapped when requested
	var report []byte
	if unpackOk {
		report = append(report, pkt("unpack ok\n")...)
	} else {
		report = append(report, pkt("unpack unpack failed\n")...)
	}
	for _, r := range results {
		if r.ok {
			report = append(report, pkt("ok "+r.ref+"\n")...)
		} else {
			report = append(report, pkt("ng "+r.ref+" "+r.reason+"\n")...)
		}
	}
	if strings.Contains(caps, "side-band-64k") {
		return append(sideband1(report), flushPkt...)
	}
	return append(report, flushPkt...)
}

func invalidateRefCaches(repo *Repo) {
	repo.PackCache = make(map[string][]byte)
	repo.RefGen++
}

func isAncestor(repo *Repo, maybeAncestor, descendant string, objects map[string]*GitObj) bool {
	parentOf := func(sha string) []string {
		if c, ok := repo.Commits[sha]; ok {
			return c.Parents
		}
		if obj, ok := objects[sha]; ok && obj.Type == ObjCommit {
			return ParseCommit(obj.Data).Parents
		}
		return nil
	}
	if maybeAncestor == descendant {
		return true
	}
	visited := map[string]bool{}
	stack := []string{descendant}
	for len(stack) > 0 {
		sha := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if visited[sha] {
			continue
		}
		visited[sha] = true
		if sha == maybeAncestor {
			return true
		}
		for _, p := range parentOf(sha) {
			if !visited[p] {
				stack = append(stack, p)
			}
		}
	}
	return false
}

// absorbObjects walks pushed commit objects into the forge store, keeping exact bytes.
func absorbObjects(repo *Repo, objects map[string]*GitObj) {
	// deterministic iteration for commit insertion order
	oids := make([]string, 0, len(objects))
	for oid := range objects {
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	for _, oid := range oids {
		obj := objects[oid]
		if obj.Type != ObjCommit {
			continue
		}
		parsed := ParseCommit(obj.Data)
		tree := make(map[string]string)
		if treeObj, ok := objects[parsed.Tree]; ok && treeObj.Type == ObjTree {
			var walk func(entries []TreeEnt, prefix string)
			walk = func(entries []TreeEnt, prefix string) {
				for _, ent := range entries {
					if ent.Mode == "40000" {
						if sub, ok := objects[ent.OID]; ok && sub.Type == ObjTree {
							walk(ParseTree(sub.Data), prefix+ent.Name+"/")
						}
					} else {
						tree[prefix+ent.Name] = ent.OID
					}
				}
			}
			walk(ParseTree(treeObj.Data), "")
		}
		if _, exists := repo.Commits[obj.OID]; !exists {
			repo.PutCommit(&CommitNode{
				Sha: obj.OID, Message: parsed.Message, Tree: tree,
				Parents: parsed.Parents, LC: int64(len(repo.Commits) + 1),
			})
			repo.CommitRaws[obj.OID] = obj.Data
		}
		for _, blobSha := range tree {
			if blobObj, ok := objects[blobSha]; ok && blobObj.Type == ObjBlob {
				repo.BlobStore[blobSha] = string(blobObj.Data)
			}
		}
	}
	for _, oid := range oids {
		obj := objects[oid]
		if obj.Type == ObjTree {
			repo.TreeRaws[obj.OID] = obj.Data
		}
	}
	for _, oid := range oids {
		obj := objects[oid]
		if obj.Type != ObjTag {
			continue
		}
		repo.TagObjects[obj.OID] = obj
	}
}

// handleV2Command routes a v2 command request (command=ls-refs | fetch).
func handleV2Command(repo *Repo, body []byte) []byte {
	packets, err := decodePackets(body)
	if err != nil {
		return append(pkt("ERR "+err.Error()+"\n"), flushPkt...)
	}
	command := ""
	var args []string
	pastDelim := false
	for _, p := range packets {
		if p.kind == 'm' {
			pastDelim = true
			continue
		}
		if p.kind == 'f' {
			break
		}
		if p.kind != 'd' {
			continue
		}
		line := strings.TrimSuffix(string(p.payload), "\n")
		if !pastDelim {
			if strings.HasPrefix(line, "command=") {
				command = strings.TrimPrefix(line, "command=")
			}
		} else if line != "" {
			args = append(args, line)
		}
	}
	switch command {
	case "ls-refs":
		return lsRefs(repo, args)
	case "fetch":
		return handleFetchV2(repo, args)
	}
	return append(pkt("ERR unknown command "+command+"\n"), flushPkt...)
}

// HandleGit serves one git smart-HTTP request; returns status, contentType, body.
func HandleGit(owner, repoName, method, path, query, gitProtocol string, body []byte) (int, string, []byte) {
	repo := GetRepoAnyOwner(repoName)
	protocolV2 := strings.Contains(gitProtocol, "version=2")

	if method == "GET" && strings.HasSuffix(path, "/info/refs") {
		if repo == nil {
			return 404, "text/plain; charset=utf-8", []byte("Not Found")
		}
		service := queryGet(query, "service")
		switch service {
		case "git-upload-pack":
			var body []byte
			if protocolV2 {
				body = advertiseUploadPackV2()
			} else {
				body = advertiseV0("git-upload-pack", repo)
			}
			return 200, "application/x-git-upload-pack-advertisement", body
		case "git-receive-pack":
			return 200, "application/x-git-receive-pack-advertisement", advertiseV0("git-receive-pack", repo)
		}
		return 400, "text/plain; charset=utf-8", []byte("dumb http protocol not supported")
	}

	if method == "POST" {
		if strings.HasSuffix(path, "/git-upload-pack") {
			if repo == nil {
				return 404, "text/plain; charset=utf-8", []byte("Not Found")
			}
			var body2 []byte
			if protocolV2 {
				body2 = handleV2Command(repo, body)
			} else {
				body2 = handleFetchV0(repo, body)
			}
			return 200, "application/x-git-upload-pack-result", body2
		}
		if strings.HasSuffix(path, "/git-receive-pack") {
			if repo == nil {
				return 404, "text/plain; charset=utf-8", []byte("Not Found")
			}
			return 200, "application/x-git-receive-pack-result", handleReceivePack(repo, body)
		}
	}

	return 404, "text/plain; charset=utf-8", []byte("Not Found")
}

func queryGet(query, key string) string {
	for _, part := range strings.Split(query, "&") {
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if kv[0] == key {
			if len(kv) == 2 {
				return urlUnescape(kv[1])
			}
			return ""
		}
	}
	return ""
}

func urlUnescape(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			hi := hexVal(s[i+1])
			lo := hexVal(s[i+2])
			if hi >= 0 && lo >= 0 {
				out = append(out, byte(hi*16+lo))
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return string(out)
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

var _ = bytes.MinRead // keep bytes import if unused elsewhere
