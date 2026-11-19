// go/main.go — the Go core's entrypoint: forgeMain binds, prints FORGE_LISTEN and serves.
package main

import (
	"os"
	"os/signal"
	"syscall"
)

func signalNotify(ch chan os.Signal) {
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
}

func main() {
	os.Exit(forgeMain())
}
