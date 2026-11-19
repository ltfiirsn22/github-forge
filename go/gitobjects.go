// go/gitobjects.go — git object model ported from gitobjects.ts: loose objects, SHA-1 oid,
// packfile read (with the two-candidate zlib-end resolution) and write, delta apply.
package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
)

type ObjType string

const (
	ObjCommit ObjType = "commit"
	ObjTree   ObjType = "tree"
	ObjBlob   ObjType = "blob"
	ObjTag    ObjType = "tag"
)

func typeNum(t ObjType) int {
	switch t {
	case ObjCommit:
		return 1
	case ObjTree:
		return 2
	case ObjBlob:
		return 3
	case ObjTag:
		return 4
	}
	return 0
}

func typeName(n int) (ObjType, error) {
	switch n {
	case 1:
		return ObjCommit, nil
	case 2:
		return ObjTree, nil
	case 3:
		return ObjBlob, nil
	case 4:
		return ObjTag, nil
	}
	return "", fmt.Errorf("bad object type %d", n)
}

type GitObj struct {
	Type ObjType
	Data []byte
	OID  string
}

// HashObject returns oid = sha1("<type> <size>\0<content>").
func HashObject(t ObjType, data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s %d\x00", t, len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func MakeObject(t ObjType, data []byte) *GitObj {
	return &GitObj{Type: t, Data: append([]byte(nil), data...), OID: HashObject(t, data)}
}

// ---------- commit ----------

type CommitParsed struct {
	Tree      string
	Parents   []string
	Author    string
	Committer string
	Message   string
}

// ParseCommit splits a raw commit at the first blank line.
func ParseCommit(data []byte) CommitParsed {
	text := string(data)
	end := bytes.Index(data, []byte("\n\n"))
	head := text
	msg := ""
	if end >= 0 {
		head = text[:end]
		msg = text[end+2:]
	}
	out := CommitParsed{Message: msg}
	for _, line := range splitLines(head) {
		switch {
		case hasPrefix(line, "tree "):
			out.Tree = line[5:]
		case hasPrefix(line, "parent "):
			out.Parents = append(out.Parents, line[7:])
		case hasPrefix(line, "author "):
			out.Author = line[7:]
		case hasPrefix(line, "committer "):
			out.Committer = line[10:]
		}
	}
	return out
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }

// SerializeCommit builds raw commit bytes.
func SerializeCommit(tree string, parents []string, authorLine, committerLine, message string) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "tree %s\n", tree)
	for _, p := range parents {
		fmt.Fprintf(&b, "parent %s\n", p)
	}
	fmt.Fprintf(&b, "author %s\n", authorLine)
	fmt.Fprintf(&b, "committer %s\n", committerLine)
	b.WriteString("\n")
	b.WriteString(message)
	return b.Bytes()
}

// ---------- tree ----------

type TreeEnt struct {
	Mode string
	Name string
	OID  string // hex
}

func ParseTree(data []byte) []TreeEnt {
	var out []TreeEnt
	i := 0
	for i < len(data) {
		sp := bytes.IndexByte(data[i:], 0x20)
		if sp < 0 {
			break
		}
		sp += i
		nul := bytes.IndexByte(data[sp+1:], 0)
		if nul < 0 {
			break
		}
		nul += sp + 1
		if nul+21 > len(data) {
			break
		}
		out = append(out, TreeEnt{
			Mode: string(data[i:sp]),
			Name: string(data[sp+1 : nul]),
			OID:  hex.EncodeToString(data[nul+1 : nul+21]),
		})
		i = nul + 21
	}
	return out
}

func SerializeTree(entries []TreeEnt) []byte {
	var b bytes.Buffer
	for _, e := range entries {
		b.WriteString(e.Mode)
		b.WriteByte(' ')
		b.WriteString(e.Name)
		b.WriteByte(0)
		oid, _ := hex.DecodeString(e.OID)
		b.Write(oid)
	}
	return b.Bytes()
}

// ---------- packfile ----------

type packEntry struct {
	typ       int
	offset    int // header offset
	dataOffset int // zlib stream start
	size      int
	baseRef   string // typ 7
	baseOfsRel int   // typ 6
}

// inflatePrefix inflates data[:k]; ok only when the zlib stream completes within it.
func inflatePrefix(data []byte, k int) ([]byte, bool) {
	zr, err := zlib.NewReader(bytes.NewReader(data[:k]))
	if err != nil {
		return nil, false
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		return nil, false
	}
	return out, true
}

// candidatesAt binary-searches the smallest prefix that inflates; also keeps the +1 byte
// fallback candidate (mirrors gitobjects.ts exactly).
func candidatesAt(pack []byte, off int, declared int) []struct {
	consumed int
	data     []byte
} {
	lo := 2
	hi := len(pack) - off
	var data []byte
	first := -1
	for lo <= hi {
		mid := (lo + hi) >> 1
		out, ok := inflatePrefix(pack[off:], mid)
		if ok {
			if len(out) != declared {
				return nil // completed stream has wrong size: not an entry here
			}
			data = out
			first = mid
			hi = mid - 1
		} else {
			lo = mid + 1
		}
	}
	if first == -1 {
		return nil
	}
	found := []struct {
		consumed int
		data     []byte
	}{{first, data}}
	if off+first+1 <= len(pack) {
		if out, ok := inflatePrefix(pack[off:], first+1); ok && len(out) == declared {
			found = append(found, struct {
				consumed int
				data     []byte
			}{first + 1, out})
		}
	}
	return found
}

// packEntries walks a pack's entry table with the two-candidate backtracking.
func packEntries(pack []byte) ([]packEntry, error) {
	if len(pack) < 12 || string(pack[:4]) != "PACK" {
		return nil, errors.New("not a packfile")
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("bad pack version %d", version)
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))

	var walk func(off, remaining int) []packEntry
	walk = func(off, remaining int) []packEntry {
		if remaining == 0 {
			if off == len(pack)-20 {
				return []packEntry{}
			}
			return nil
		}
		if off >= len(pack)-20 || remaining < 0 {
			return nil
		}
		start := off
		b := pack[off]
		off++
		typ := int((b >> 4) & 7)
		size := int(b & 0x0f)
		shift := 4
		for b&0x80 != 0 {
			if off >= len(pack) {
				return nil
			}
			b = pack[off]
			off++
			size |= int(b&0x7f) << shift
			shift += 7
		}
		entry := packEntry{typ: typ, offset: start, dataOffset: off, size: size}
		if typ == 6 {
			if off >= len(pack) {
				return nil
			}
			b = pack[off]
			off++
			value := int(b & 0x7f)
			for b&0x80 != 0 {
				if off >= len(pack) {
					return nil
				}
				b = pack[off]
				off++
				value = ((value + 1) << 7) | int(b&0x7f)
			}
			entry.baseOfsRel = value
		} else if typ == 7 {
			if off+20 > len(pack) {
				return nil
			}
			entry.baseRef = hex.EncodeToString(pack[off : off+20])
			off += 20
		}
		entry.dataOffset = off
		for _, cand := range candidatesAt(pack, off, size) {
			entry.size = len(cand.data)
			rest := walk(off+cand.consumed, remaining-1)
			if rest != nil {
				return append([]packEntry{entry}, rest...)
			}
		}
		return nil
	}

	solved := walk(12, count)
	if solved == nil {
		return nil, fmt.Errorf("pack entry table does not resolve to %d objects ending at the trailer", count)
	}
	return solved, nil
}

// ReadPack fully resolves a pack into objects (deltas applied). external resolves ref-delta
// bases outside the pack (nil when none).
func ReadPack(pack []byte, external func(oid string) *GitObj) (map[string]*GitObj, error) {
	if len(pack) < 12 || string(pack[:4]) != "PACK" {
		return nil, errors.New("not a packfile")
	}
	count := int(binary.BigEndian.Uint32(pack[8:12]))
	entries, err := packEntries(pack)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*GitObj, count)
	byOffset := make(map[int]struct {
		typ  int
		data []byte
	})
	offsetIndex := make(map[int]int, len(entries)) // offset -> entry idx
	for i, e := range entries {
		offsetIndex[e.offset] = i
	}

	inflateAt := func(e packEntry) ([]byte, error) {
		zr, err := zlib.NewReader(bytes.NewReader(pack[e.dataOffset:]))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	}

	var resolve func(idx, depth int) (int, []byte, error)
	resolve = func(idx, depth int) (int, []byte, error) {
		e := entries[idx]
		if c, ok := byOffset[e.offset]; ok {
			return c.typ, c.data, nil
		}
		if depth > 64 {
			return 0, nil, errors.New("delta chain too deep")
		}
		typ := e.typ
		var data []byte
		var err error
		switch typ {
		case 6:
			baseOffset := e.offset - e.baseOfsRel
			baseIdx, ok := offsetIndex[baseOffset]
			if !ok {
				return 0, nil, fmt.Errorf("ofs-delta base offset %d not found", baseOffset)
			}
			bt, bd, err := resolve(baseIdx, depth+1)
			if err != nil {
				return 0, nil, err
			}
			delta, err := inflateAt(e)
			if err != nil {
				return 0, nil, err
			}
			data, err = ApplyDelta(bd, delta)
			if err != nil {
				return 0, nil, err
			}
			typ = bt
		case 7:
			var base struct {
				typ  int
				data []byte
			}
			var found bool
			// objects already resolved from this pack
			if o, ok := out[e.baseRef]; ok {
				base.typ, base.data, found = typeNum(o.Type), o.Data, true
			} else if external != nil {
				if ext := external(e.baseRef); ext != nil {
					base.typ, base.data, found = typeNum(ext.Type), ext.Data, true
				}
			}
			if !found {
				return 0, nil, fmt.Errorf("ref-delta base %s not found", e.baseRef)
			}
			delta, err := inflateAt(e)
			if err != nil {
				return 0, nil, err
			}
			data, err = ApplyDelta(base.data, delta)
			if err != nil {
				return 0, nil, err
			}
			typ = base.typ
		default:
			data, err = inflateAt(e)
			if err != nil {
				return 0, nil, err
			}
		}
		byOffset[e.offset] = struct {
			typ  int
			data []byte
		}{typ, data}
		tn, _ := typeName(typ)
		obj := MakeObject(tn, data)
		out[obj.OID] = obj
		return typ, data, nil
	}

	for i := 0; i < count; i++ {
		if _, _, err := resolve(i, 0); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ApplyDelta applies a git delta buffer to a base (ported from applyDelta).
func ApplyDelta(base, delta []byte) ([]byte, error) {
	p := 0
	readVar := func() uint32 {
		var v uint32
		var shift uint
		for {
			b := delta[p]
			p++
			v |= uint32(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
		}
		return v
	}
	baseSize := readVar()
	if uint32(len(base)) != baseSize {
		return nil, fmt.Errorf("delta base size %d != %d", baseSize, len(base))
	}
	targetSize := readVar()
	var parts [][]byte
	for p < len(delta) {
		op := delta[p]
		p++
		if op&0x80 != 0 {
			var offset, size uint32
			if op&0x01 != 0 {
				offset |= uint32(delta[p])
				p++
			}
			if op&0x02 != 0 {
				offset |= uint32(delta[p]) << 8
				p++
			}
			if op&0x04 != 0 {
				offset |= uint32(delta[p]) << 16
				p++
			}
			if op&0x08 != 0 {
				offset |= uint32(delta[p]) << 24
				p++
			}
			if op&0x10 != 0 {
				size |= uint32(delta[p])
				p++
			}
			if op&0x20 != 0 {
				size |= uint32(delta[p]) << 8
				p++
			}
			if op&0x40 != 0 {
				size |= uint32(delta[p]) << 16
				p++
			}
			if size == 0 {
				size = 0x10000
			}
			parts = append(parts, base[offset:offset+size])
		} else {
			if op == 0 {
				return nil, errors.New("delta op 0x00 is invalid")
			}
			parts = append(parts, delta[p:p+int(op)])
			p += int(op)
		}
	}
	total := 0
	for _, part := range parts {
		total += len(part)
	}
	out := make([]byte, 0, total)
	for _, part := range parts {
		out = append(out, part...)
	}
	if uint32(len(out)) != targetSize {
		return nil, fmt.Errorf("delta target size %d != %d", targetSize, len(out))
	}
	return out, nil
}

// WritePack writes a v2 pack with full objects, no deltas, deflate level 1 (as TS).
func WritePack(objects []*GitObj) []byte {
	var b bytes.Buffer
	b.WriteString("PACK")
	var head [8]byte
	binary.BigEndian.PutUint32(head[0:4], 2)
	binary.BigEndian.PutUint32(head[4:8], uint32(len(objects)))
	b.Write(head[:])
	for _, obj := range objects {
		typ := typeNum(obj.Type)
		size := len(obj.Data)
		first := (typ << 4) | (size & 0x0f)
		size >>= 4
		var hdr []byte
		for size > 0 {
			hdr = append(hdr, byte(first|0x80))
			first = size & 0x7f
			size >>= 7
		}
		hdr = append(hdr, byte(first))
		b.Write(hdr)
		var zw *zlib.Writer
		zw, _ = zlib.NewWriterLevel(&b, 1)
		zw.Write(obj.Data)
		zw.Close()
	}
	body := b.Bytes()
	sum := sha1.Sum(body)
	return append(body, sum[:]...)
}

// SortObjectsByOID returns the objects sorted by oid for deterministic pack order
// (Go map iteration is randomized; the TS side's writePack received map values — its order
// was insertion-stable, so we sort to stay deterministic).
func SortObjectsByOID(objs []*GitObj) {
	sort.Slice(objs, func(i, j int) bool { return objs[i].OID < objs[j].OID })
}
