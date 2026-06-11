# Playwright + extras for Status Pipe extension E2E and snapshot tests.
# Used by docker-compose.test.yml. Same image runs locally and on CI so
# snapshot PNGs are byte-identical across hosts.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# git-lfs to materialize the snapshot PNGs from .gitattributes pointers; git is
# needed by the test fixtures (generated temp repos).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs install --skip-repo

WORKDIR /work
