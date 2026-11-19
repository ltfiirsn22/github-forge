// go/json.go — insertion-ordered JSON writer that matches Node's JSON.stringify byte for byte:
// keys in insertion order, no HTML escaping of < > &, minimal float formatting (integers plain).
// ponytail: covers only the shapes the forge emits (strings/ints/bools/nested maps/arrays/null);
// upgrade to a full encoder if exotic values ever appear.
package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// OMap is a JSON object that preserves insertion order (like a JS object literal).
type OMap struct {
	keys []string
	vals map[string]any
}

func NewOMap() *OMap { return &OMap{vals: make(map[string]any)} }

func (o *OMap) Set(key string, value any) *OMap {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = value
	return o
}

func (o *OMap) Get(key string) (any, bool) { v, ok := o.vals[key]; return v, ok }

// Keys returns the keys in insertion order.
func (o *OMap) Keys() []string { return append([]string(nil), o.keys...) }

// writeJSON appends the JSON encoding of v to b (Node-compatible, insertion order for OMap).
func writeJSON(b []byte, v any) []byte {
	switch x := v.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		if x {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case string:
		return writeJSONString(b, x)
	case int:
		return strconv.AppendInt(b, int64(x), 10)
	case int64:
		return strconv.AppendInt(b, x, 10)
	case float64:
		return writeJSONFloat(b, x)
	case []string:
		b = append(b, '[')
		for i, s := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = writeJSONString(b, s)
		}
		return append(b, ']')
	case []any:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = writeJSON(b, e)
		}
		return append(b, ']')
	case jsonRaw:
		return append(b, x...)
	case *OMap:
		b = append(b, '{')
		for i, k := range x.keys {
			if i > 0 {
				b = append(b, ',')
			}
			b = writeJSONString(b, k)
			b = append(b, ':')
			b = writeJSON(b, x.vals[k])
		}
		return append(b, '}')
	case map[string]string:
		// plain Go map: sorted keys (deterministic fallback)
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b = append(b, '{')
		for i, k := range keys {
			if i > 0 {
				b = append(b, ',')
			}
			b = writeJSONString(b, k)
			b = append(b, ':')
			b = writeJSONString(b, x[k])
		}
		return append(b, '}')
	default:
		return writeJSONString(b, fmt.Sprintf("%v", x))
	}
}

// mustJSON encodes v in one freshly-allocated buffer.
func mustJSON(v any) []byte { return writeJSON(nil, v) }

// writeJSONString escapes like JSON.stringify: standard escapes, control chars as \uXXXX,
// and NO escaping of < > & (unlike Go's encoding/json).
func writeJSONString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			b = append(b, '\\', '"')
		case c == '\\':
			b = append(b, '\\', '\\')
		case c == '\n':
			b = append(b, '\\', 'n')
		case c == '\r':
			b = append(b, '\\', 'r')
		case c == '\t':
			b = append(b, '\\', 't')
		case c == '\b':
			b = append(b, '\\', 'b')
		case c == '\f':
			b = append(b, '\\', 'f')
		case c < 0x20:
			b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		default:
			b = append(b, c)
		}
	}
	return append(b, '"')
}

const hexDigits = "0123456789abcdef"

// writeJSONFloat matches JS number-to-string for the values the forge emits (integral floats
// print without a decimal point).
func writeJSONFloat(b []byte, f float64) []byte {
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.AppendInt(b, int64(f), 10)
	}
	return strconv.AppendFloat(b, f, 'g', -1, 64)
}

// jsonString is the quoted form of s alone (helper for embedded literals).
func jsonString(s string) string { return string(writeJSONString(nil, s)) }

// parseSimpleJSON decodes a flat JSON object body into map[string]any (numbers as float64,
// like JS). It is a minimal recursive-descent decoder — enough for the suite's request bodies.
func parseSimpleJSON(data []byte) (any, error) {
	p := &jsonParser{data: data}
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	return v, nil
}

type jsonParser struct {
	data []byte
	pos  int
}

func (p *jsonParser) ws() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) value() (any, error) {
	if p.pos >= len(p.data) {
		return nil, fmt.Errorf("unexpected end of JSON")
	}
	switch c := p.data[p.pos]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		s, err := p.str()
		return s, err
	case c == 't':
		if err := p.literal("true"); err != nil {
			return nil, err
		}
		return true, nil
	case c == 'f':
		if err := p.literal("false"); err != nil {
			return nil, err
		}
		return false, nil
	case c == 'n':
		if err := p.literal("null"); err != nil {
			return nil, err
		}
		return nil, nil
	default:
		return p.number()
	}
}

func (p *jsonParser) literal(word string) error {
	if p.pos+len(word) > len(p.data) || string(p.data[p.pos:p.pos+len(word)]) != word {
		return fmt.Errorf("bad literal at %d", p.pos)
	}
	p.pos += len(word)
	return nil
}

func (p *jsonParser) object() (any, error) {
	p.pos++ // {
	out := NewOMap()
	p.ws()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		return out, nil
	}
	for {
		p.ws()
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return nil, fmt.Errorf("expected : at %d", p.pos)
		}
		p.pos++
		p.ws()
		val, err := p.value()
		if err != nil {
			return nil, err
		}
		out.Set(key, val)
		p.ws()
		if p.pos >= len(p.data) {
			return nil, fmt.Errorf("unterminated object")
		}
		if p.data[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.data[p.pos] == '}' {
			p.pos++
			return out, nil
		}
		return nil, fmt.Errorf("expected , or } at %d", p.pos)
	}
}

func (p *jsonParser) array() (any, error) {
	p.pos++ // [
	out := []any{}
	p.ws()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		return out, nil
	}
	for {
		p.ws()
		val, err := p.value()
		if err != nil {
			return nil, err
		}
		out = append(out, val)
		p.ws()
		if p.pos >= len(p.data) {
			return nil, fmt.Errorf("unterminated array")
		}
		if p.data[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.data[p.pos] == ']' {
			p.pos++
			return out, nil
		}
		return nil, fmt.Errorf("expected , or ] at %d", p.pos)
	}
}

func (p *jsonParser) str() (string, error) {
	if p.pos >= len(p.data) || p.data[p.pos] != '"' {
		return "", fmt.Errorf("expected string at %d", p.pos)
	}
	p.pos++
	var sb strings.Builder
	for p.pos < len(p.data) {
		c := p.data[p.pos]
		if c == '"' {
			p.pos++
			return sb.String(), nil
		}
		if c == '\\' && p.pos+1 < len(p.data) {
			e := p.data[p.pos+1]
			switch e {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			case 'r':
				sb.WriteByte('\r')
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'u':
				if p.pos+5 < len(p.data) {
					n, err := strconv.ParseUint(string(p.data[p.pos+2:p.pos+6]), 16, 32)
					if err == nil {
						sb.WriteRune(rune(n))
						p.pos += 4
					} else {
						sb.WriteByte(e)
					}
				} else {
					sb.WriteByte(e)
				}
			default:
				sb.WriteByte(e)
			}
			p.pos += 2
			continue
		}
		sb.WriteByte(c)
		p.pos++
	}
	return "", fmt.Errorf("unterminated string")
}

func (p *jsonParser) number() (any, error) {
	start := p.pos
	for p.pos < len(p.data) {
		c := p.data[p.pos]
		if (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' {
			p.pos++
			continue
		}
		break
	}
	if p.pos == start {
		return nil, fmt.Errorf("bad number at %d", start)
	}
	f, err := strconv.ParseFloat(string(p.data[start:p.pos]), 64)
	if err != nil {
		return nil, err
	}
	return f, nil
}
