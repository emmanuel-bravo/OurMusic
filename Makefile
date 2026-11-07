.PHONY: all build test start clean wasapi-check

all: build

build:
	bash scripts/build-linux.sh

wasapi-check:
	gcc -fsyntax-only -Wall -Wextra -Wno-unused-parameter -std=c11 -D_POSIX_C_SOURCE=200809L -DOM_WASAPI_SYNTAX_CHECK native/hal_wasapi.c

start: build
	node src/index.mjs

test: build wasapi-check
	node tests/run_all_tests.mjs

clean:
	rm -rf bin/ourmusic-engine bin/ourmusic-gui tests/.tmp_fixtures
