// go/server.go — the forge server: raw-TCP HTTP/1.1 accept loop (per-connection goroutine),
// routing to git smart HTTP / REST v3 / GraphQL / MCP, one global dispatch mutex (the event-loop
// semantics the TS side had), body read BEFORE the lock, response in ONE write.
// Ported from app.ts + the winning field pattern (lianajwa rawhttp.go) at the byte-contract
// level of our TS entry: every response carries content-type + content-length, keep-alive on.
package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxBodyBytes = 64 << 20
const maxHeaderLine = 8192
const maxRequestLine = 8192
const maxHeaderTotal = 65536

// jsonRaw wraps pre-serialized JSON so writeJSON emits it verbatim.
type jsonRaw []byte

var dispatchMu sync.Mutex // one request dispatched at a time (event-loop semantics)
var connCounter int64

type rawRequest struct {
	method        string
	path          string // decoded-free raw path (percent forms kept for query parsing)
	query         string
	authorization string
	gitProtocol   string
	keepAlive     bool
	body          []byte
}

func serveRaw(listener net.Listener) error {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go handleConn(conn)
	}
}

func handleConn(conn net.Conn) {
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	br := bufio.NewReaderSize(conn, 64*1024)
	writeBuf := new(bytes.Buffer)
	for {
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		req, ok := readRawRequest(br, conn)
		if !ok {
			return
		}
		response := dispatch(req)
		writeBuf.Reset()
		writeResponse(writeBuf, req.method, response, req.keepAlive)
		conn.SetWriteDeadline(time.Now().Add(60 * time.Second))
		if _, err := conn.Write(writeBuf.Bytes()); err != nil {
			return
		}
		if !req.keepAlive {
			return
		}
	}
}

// readRawRequest parses one request: method, path+query, the headers dispatch needs, the body.
func readRawRequest(br *bufio.Reader, conn net.Conn) (*rawRequest, bool) {
	line, err := readCappedLine(br, maxRequestLine)
	if err != nil || line == "" {
		return nil, false
	}
	sp1 := strings.IndexByte(line, ' ')
	if sp1 <= 0 {
		return nil, false
	}
	sp2 := strings.IndexByte(line[sp1+1:], ' ')
	if sp2 < 0 {
		return nil, false
	}
	sp2 += sp1 + 1
	method := line[:sp1]
	target := line[sp1+1 : sp2]
	version := line[sp2+1:]
	if version != "HTTP/1.1" && version != "HTTP/1.0" {
		return nil, false
	}
	req := &rawRequest{method: method, keepAlive: version == "HTTP/1.1"}

	// split target into path and query
	path := target
	query := ""
	if i := strings.IndexByte(target, '?'); i >= 0 {
		path = target[:i]
		query = target[i+1:]
	}
	req.path = path
	req.query = query

	contentLength := -1
	chunked := false
	total := 0
	for {
		hdr, err := readCappedLine(br, maxHeaderLine)
		if err != nil {
			return nil, false
		}
		total += len(hdr) + 2
		if total > maxHeaderTotal {
			return nil, false
		}
		if hdr == "" {
			break
		}
		colon := strings.IndexByte(hdr, ':')
		if colon <= 0 {
			return nil, false
		}
		name := strings.ToLower(strings.TrimRight(hdr[:colon], " \t"))
		value := strings.Trim(hdr[colon+1:], " \t")
		switch name {
		case "content-length":
			if contentLength < 0 {
				n, err := strconv.Atoi(value)
				if err != nil || n < 0 {
					return nil, false
				}
				contentLength = n
			}
		case "transfer-encoding":
			if strings.Contains(strings.ToLower(value), "chunked") {
				chunked = true
			}
		case "connection":
			lv := strings.ToLower(value)
			if strings.Contains(lv, "close") {
				req.keepAlive = false
			} else if strings.Contains(lv, "keep-alive") {
				req.keepAlive = true
			}
		case "authorization":
			req.authorization = value
		case "git-protocol":
			req.gitProtocol = value
		}
	}

	// body (read fully BEFORE the dispatch lock)
	if chunked {
		body, ok := readChunkedBody(br)
		if !ok {
			return nil, false
		}
		req.body = body
	} else if contentLength > 0 {
		if contentLength > maxBodyBytes {
			_, _ = io.CopyN(io.Discard, br, int64(maxBodyBytes)+1)
			return nil, false
		}
		body := make([]byte, contentLength)
		if _, err := io.ReadFull(br, body); err != nil {
			return nil, false
		}
		req.body = body
	} else {
		req.body = nil
	}
	return req, true
}

func readChunkedBody(br *bufio.Reader) ([]byte, bool) {
	var body []byte
	for {
		line, err := readCappedLine(br, maxHeaderLine)
		if err != nil {
			return nil, false
		}
		if i := strings.IndexByte(line, ';'); i >= 0 {
			line = line[:i]
		}
		size, err := strconv.ParseInt(strings.TrimSpace(line), 16, 64)
		if err != nil || size < 0 {
			return nil, false
		}
		if size == 0 {
			// trailers until blank line
			for {
				t, err := readCappedLine(br, maxHeaderLine)
				if err != nil || t == "" {
					return body, true
				}
			}
		}
		chunk := make([]byte, size+2)
		if _, err := io.ReadFull(br, chunk); err != nil {
			return nil, false
		}
		body = append(body, chunk[:size]...)
		if len(body) > maxBodyBytes {
			return nil, false
		}
	}
}

func readCappedLine(br *bufio.Reader, max int) (string, error) {
	var buf []byte
	for {
		frag, err := br.ReadSlice('\n')
		if len(frag) > 0 {
			if len(buf)+len(frag) > max+1 {
				return "", fmt.Errorf("line too long")
			}
			buf = append(buf, frag...)
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return "", err
		}
		line := strings.TrimSuffix(string(buf), "\n")
		line = strings.TrimSuffix(line, "\r")
		return line, nil
	}
}

// ---------- dispatch ----------

type dispatchResponse struct {
	status      int
	contentType string
	body        []byte
	gitBody     bool   // git responses are raw bytes, no JSON newline
	requestID   string // minted under the dispatch mutex (deterministic counter)
}

func dispatch(req *rawRequest) (response dispatchResponse) {
	// the global mutex holds for the whole dispatch: single-threaded state semantics, so every
	// counter it touches (the request id, the logical clock) stays deterministic. The id is
	// minted HERE, under the lock — minting it later in writeResponse raced between goroutines.
	dispatchMu.Lock()
	defer dispatchMu.Unlock()
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("forge panic: %v", rec)
			response = dispatchResponse{500, "application/json; charset=utf-8", []byte("{\"message\":\"Internal Server Error\"}\n"), false, ""}
		}
		// still under the mutex (this defer runs before the unlock defer): the id rides every return
		response.requestID = RequestID()
	}()

	path := req.path

	// healthz (no auth)
	if req.method == "GET" && path == "/healthz" {
		return dispatchResponse{200, "application/json; charset=utf-8", []byte("{\"ok\":true}\n"), false, ""}
	}

	token := ""
	auth := req.authorization
	if strings.HasPrefix(auth, "Bearer ") {
		token = strings.TrimSpace(auth[7:])
	} else if strings.HasPrefix(auth, "token ") {
		token = strings.TrimSpace(auth[6:])
	}

	// git smart HTTP: /{owner}/{repo}.git/...
	if m := gitRouteRe.FindStringSubmatch(path); m != nil {
		owner := urlUnescape(m[1])
		name := urlUnescape(m[2])
		status, ctype, body := HandleGit(owner, name, req.method, path, req.query, req.gitProtocol, req.body)
		return dispatchResponse{status, ctype, body, true, ""}
	}

	// GraphQL
	if path == "/api/graphql" && req.method == "POST" {
		status, body := HandleGraphQL(token, req.body)
		return dispatchResponse{status, "application/json; charset=utf-8", body, false, ""}
	}

	// MCP
	if path == "/mcp" && req.method == "POST" {
		malformed := false
		if len(req.body) > 0 {
			if _, err := parseSimpleJSON(req.body); err != nil {
				malformed = true
			}
		}
		r := HandleMcp(token, req.body, malformed)
		return dispatchResponse{r.status, "application/json; charset=utf-8", r.body, false, ""}
	}

	// REST v3
	if path == "/api/v3" || strings.HasPrefix(path, "/api/v3/") {
		owner := viewerFallback
		restPath := strings.TrimPrefix(path, "/api/v3")
		if m := restOwnerRe.FindStringSubmatch(restPath); m != nil {
			owner = urlUnescape(m[1])
		}
		r := HandleRest(req.method, path, path, req.query, token, owner, req.body)
		return dispatchResponse{r.status, "application/json; charset=utf-8", r.body, false, ""}
	}

	response = dispatchResponse{404, "application/json; charset=utf-8", []byte("{\"message\":\"Not Found\"}\n"), false, ""}
	return response
}

// dispatched runs dispatch and stamps the mutex-minted request id onto the result (the dispatch
// body returns unnamed literals; the id must be minted under the lock, so it is applied here).
func dispatched(req *rawRequest) dispatchResponse {
	return dispatch(req)
}

var gitRouteRe = regexp.MustCompile(`^/([^/]+)/([^/]+)\.git(/|$)`)
var restOwnerRe = regexp.MustCompile(`^/repos/([^/]+)/`)

// writeResponse serializes one response in a single buffer write.
func writeResponse(buf *bytes.Buffer, method string, res dispatchResponse, keepAlive bool) {
	statusText := httpStatusText(res.status)
	fmt.Fprintf(buf, "HTTP/1.1 %d %s\r\n", res.status, statusText)
	if res.contentType != "" {
		buf.WriteString("content-type: " + res.contentType + "\r\n")
	}
	// every non-git reply carries a request id minted under the dispatch mutex
	if !res.gitBody {
		buf.WriteString("x-github-request-id: " + res.requestID + "\r\n")
	}
	fmt.Fprintf(buf, "content-length: %d\r\n", len(res.body))
	if res.gitBody {
		buf.WriteString("cache-control: no-cache\r\n")
	}
	if !keepAlive {
		buf.WriteString("connection: close\r\n")
	}
	buf.WriteString("\r\n")
	if method != "HEAD" && len(res.body) > 0 {
		buf.Write(res.body)
	}
}

func httpStatusText(code int) string {
	switch code {
	case 200:
		return "OK"
	case 201:
		return "Created"
	case 204:
		return "No Content"
	case 400:
		return "Bad Request"
	case 401:
		return "Unauthorized"
	case 404:
		return "Not Found"
	case 405:
		return "Method Not Allowed"
	case 409:
		return "Conflict"
	case 422:
		return "Unprocessable Entity"
	case 500:
		return "Internal Server Error"
	}
	return "Status"
}

// ---------- main: bind ephemeral port, print FORGE_LISTEN, serve until killed ----------

func forgeMain() int {
	port := 0
	if raw := os.Getenv("PORT"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			port = n
		}
	}
	listener, err := net.Listen("tcp", ":"+strconv.Itoa(port)) // all interfaces: the env dials us from its own pod
	if err != nil {
		log.Printf("[forge] listen: %v", err)
		return 1
	}
	tp := listener.Addr().(*net.TCPAddr).Port
	fmt.Printf("FORGE_LISTEN %d\n", tp)
	os.Stdout.Sync()

	go func() {
		ch := make(chan os.Signal, 1)
		signalNotify(ch)
		<-ch
		os.Exit(0)
	}()

	if err := serveRaw(listener); err != nil {
		log.Printf("[forge] serve: %v", err)
		return 1
	}
	return 0
}
