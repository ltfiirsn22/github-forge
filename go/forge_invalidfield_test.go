package main

import (
	"bytes"
	"testing"
)

// TestGraphQLInvalidField reproduces the typed-nil crash: a query naming an unknown field must
// answer HTTP 200 with an errors array naming the field and "data":null — before the writeJSON
// nil-*OMap guard this exact call panicked with a nil pointer dereference.
func TestGraphQLInvalidField(t *testing.T) {
	status, body := HandleGraphQL("tok", []byte(`{"query":"query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }"}`))
	if status != 200 {
		t.Fatalf("status = %d, want 200", status)
	}
	if !bytes.Contains(body, []byte("noSuchFieldOnViewer")) {
		t.Fatalf("errors do not name the invalid field: %s", body)
	}
	if !bytes.Contains(body, []byte(`"data":null`)) {
		t.Fatalf("data is not null: %s", body)
	}
}
