<p align="center">
  <picture>
    <!-- Dark mode -->
    <source media="(prefers-color-scheme: dark)" srcset="./Blacksmith_Logo-White-Large.png" width="300">
    <!-- Light mode -->
    <source media="(prefers-color-scheme: light)" srcset="./Blacksmith_Logo-Black-Large.png" width="300">
    <img alt="Blacksmith Logo" src="./Blacksmith_Logo-Black-Large.png" width="300">
  </picture>
</p>

A GitHub Action that helps persist state written to disk across jobs. This action can serve as a superior alternative to the [Actions cache](https://github.com/useblacksmith/cache), especially when the cache artifacts are extremely large. Each sticky disk is hot-loaded into the runner and mounted at the specified path.
The sticky disk is formatted as an ext4 filesystem.

> [!CAUTION]
> Alpha: This GitHub Action is currently in Alpha. There may be bugs, and the inputs/outputs and overall behavior may change without notice.

# Architecture

<p align="center">
  <picture>
    <!-- Dark mode -->
    <source media="(prefers-color-scheme: dark)" srcset="./arch-dark-mode.png" width="1000">
    <!-- Light mode -->
    <source media="(prefers-color-scheme: light)" srcset="./arch-light.png" width="1000">
    <img alt="Blacksmith Logo" src="./arch-light.png" width="1000">
  </picture>
</p>

Blacksmith stores sticky disk artifacts in a secure, highly performant Ceph cluster, running on local NVMe drives. Our runners proxy their requests through our Storage Agents to interact with the Ceph cluster. Each sticky disk is uniquely identified by a key. When a GitHub Action job requests a sticky disk, the last committed snapshot will be cloned and mounted into the runner at the specified path. Once the job completes, the sticky disk will be unmounted and committed for future invocations. At the moment, customers can use up to 5 sticky disks in a single GitHub Action job.

# Use Cases

Based on production usage across 58+ installations, sticky disks are commonly used for:

## JavaScript Package Management

### NPM/pnpm Cache

Store the npm global cache for faster dependency resolution. The cache is accessed by content hash, providing instant lookups.

```yaml
jobs:
  build:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20.x"

      - name: Mount NPM Cache
        uses: useblacksmith/stickydisk@v1
        with:
          key: ${{ github.repository }}-npm-cache
          path: ~/.npm

      - name: Install Dependencies
        run: npm ci

      - name: Build
        run: npm run build
```

### Turborepo Remote Cache

Turborepo's local cache benefits from persistent storage, dramatically reducing build times for monorepos.

```yaml
jobs:
  build:
    runs-on: blacksmith-8vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 8

      - name: Mount Turborepo Cache
        uses: useblacksmith/stickydisk@v1
        with:
          key: ${{ github.repository }}-turbo-${{ github.ref_name }}-${{ hashFiles('**/pnpm-lock.yaml') }}
          path: .turbo

      - name: Install Dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm turbo build
```

## Go Build Cache

Go's build cache can grow to hundreds of gigabytes for large projects. Sticky disks provide instant access without expensive downloads.

```yaml
jobs:
  build:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"

      - name: Mount Go Build Cache
        uses: useblacksmith/stickydisk@v1
        with:
          key: ${{ github.repository }}-go-build-cache-${{ runner.os }}
          path: ~/.cache/go-build

      - name: Mount Go Module Cache
        uses: useblacksmith/stickydisk@v1
        with:
          key: ${{ github.repository }}-go-mod-cache-${{ runner.os }}
          path: ~/go/pkg/mod

      - name: Build
        run: go build ./...

      - name: Test
        run: go test ./...
```

## Python Virtual Environments

Poetry and pip virtual environments can be large and slow to recreate. Sticky disks make them persistent across jobs.

```yaml
jobs:
  test:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.10"

      - name: Install Poetry
        run: pipx install poetry

      - name: Mount Poetry Virtual Environment
        uses: useblacksmith/stickydisk@v1
        with:
          key: poetry-venv-${{ github.repository }}-${{ runner.os }}-${{ hashFiles('**/poetry.lock') }}
          path: .venv

      - name: Install Dependencies
        run: |
          poetry config virtualenvs.in-project true
          poetry install --no-interaction

      - name: Run Tests
        run: poetry run pytest
```

## Nix Package Cache

Nix store can be massive for large projects. Sticky disks provide persistent Nix caches without impacting build times.

```yaml
jobs:
  build:
    runs-on: blacksmith-8vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Install Nix
        uses: cachix/install-nix-action@v24

      - name: Mount Nix Store
        uses: useblacksmith/stickydisk@v1
        with:
          key: ${{ github.repository }}-nix-cache-${{ runner.os }}
          path: /nix

      - name: Build
        run: nix build

      - name: Test
        run: nix flake check
```

## End-to-End Testing

### Playwright Browser Binaries

Playwright browser downloads are large (~1GB) and slow. Sticky disks make them instantly available.

```yaml
jobs:
  e2e-tests:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20.x"

      - name: Mount Playwright Browsers
        uses: useblacksmith/stickydisk@v1
        with:
          key: playwright-browsers-${{ runner.os }}
          path: ~/.cache/ms-playwright

      - name: Install Dependencies
        run: npm ci

      - name: Install Playwright Browsers
        run: npx playwright install --with-deps

      - name: Run E2E Tests
        run: npx playwright test
```

## Cache Performance Comparison

| Caching Solution     | Cache Size | Average Download Speed | Time to Access |
| -------------------- | ---------- | ---------------------- | -------------- |
| GitHub Actions Cache | 6GB        | 90 MB/s                | ~1m6s          |
| Blacksmith Cache     | 6GB        | 400 MB/s               | ~15s           |
| Sticky Disks         | 6GB        | N/A                    | 3 seconds      |

## Additional Use Cases

Sticky disks are also used in production for:
- **Database Fixtures**: Persistent test databases for E2E testing (~2TB across 3 installations)
- **Android Gradle Cache**: Build cache for Android projects (~18GB per project)
- **Rust Cargo Cache**: Dependency and build artifacts (~36GB)
- **Cypress Cache**: E2E testing browser binaries
- **Git LFS Objects**: Large file storage for game development and media projects

# useblacksmith/stickydisk-delete

[useblacksmith/stickydisk-delete](https://github.com/useblacksmith/stickydisk-delete) allows you to delete sticky disks programmatically. It supports two deletion methods:

## Delete by Key

Delete a specific sticky disk using its key:

```yaml
- name: Delete sticky disk
  uses: useblacksmith/stickydisk-delete@v1
  with:
    delete-key: my-cache-disk
```

## Delete Docker Cache

Delete Docker build cache for your repository. This should be used in conjunction with `useblacksmith/setup-docker-builder@v1`, which sets up the sticky disk for Docker build caching:

```yaml
- name: Delete Docker cache
  uses: useblacksmith/stickydisk-delete@v1
  with:
    delete-docker-cache: true
```

## Example: Cleanup After Build

```yaml
name: Build with Cleanup
on: push

jobs:
  build:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    steps:
      - name: Create sticky disk for dependencies
        uses: useblacksmith/stickydisk@v1
        with:
          key: deps-cache
          path: ~/.npm

      - uses: actions/checkout@v4

      - name: Install and build
        run: |
          npm ci
          npm run build

  cleanup:
    runs-on: blacksmith-4vcpu-ubuntu-2204
    needs: build
    if: always()
    steps:
      - name: Delete sticky disk
        uses: useblacksmith/stickydisk-delete@v1
        with:
          delete-key: deps-cache
```
