# ArchWeave — container image release
#
# Builds the versioned image and optionally pushes it to GitHub Container Registry.
#
#   make release VERSION=0.1.0                 Build for the local Docker daemon
#   make release VERSION=0.1.0 PUSH=true       Build linux/amd64 + linux/arm64 and push
#   make release VERSION=0.1.0 IMAGE_NAME=x    Override the image name
#
# VERSION matches the Git tag without the "v" prefix (tag v0.1.0 → VERSION=0.1.0).
# A pre-release version (one with a "-", e.g. 0.2.0-beta.1) does not get the latest tag.

.PHONY: help release _check-version

REGISTRY ?= ghcr.io/rawe
IMAGE_NAME ?= archweave
IMAGE := $(REGISTRY)/$(IMAGE_NAME)

LATEST := $(if $(findstring -,$(VERSION)),,-t $(IMAGE):latest)

GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

BUILD_ARGS := \
	--build-arg VERSION=$(VERSION) \
	--build-arg GIT_COMMIT=$(GIT_COMMIT) \
	--build-arg BUILD_DATE=$(BUILD_DATE) \
	-t $(IMAGE):$(VERSION) $(LATEST)

help:
	@echo "make release VERSION=x.y.z             Build the image locally"
	@echo "make release VERSION=x.y.z PUSH=true   Build multi-arch and push to $(REGISTRY)"

_check-version:
ifndef VERSION
	$(error VERSION is required. Usage: make release VERSION=0.1.0)
endif

release: _check-version
ifdef PUSH
	docker buildx build \
		--platform linux/amd64,linux/arm64 \
		--cache-from type=registry,ref=$(IMAGE):buildcache \
		--cache-to type=registry,ref=$(IMAGE):buildcache,mode=max \
		$(BUILD_ARGS) --push .
else
	docker buildx build $(BUILD_ARGS) --load .
endif
	@echo "Built $(IMAGE):$(VERSION)"
