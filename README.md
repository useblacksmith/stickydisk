# Blacksmith Sticky Disk Action

A GitHub Action that helps persist state written to disk across jobs. Each sticky disk is backed by local NVMe storage and is formmatted as an ext4 filesystem.

Some common use cases of this action include:

- Caching Docker images to minimize pull and extract times
- Caching build artifacts such as NPM packages (egs: node_modules, yarn.lock, etc)
- Caching Bazel build artifacts
- Caching large GitHub repositories to minimize checkout times

## Usage

```yaml
jobs:
  build:
    runs-on: blacksmith
    steps:
      - name: Cache NPM packages
        uses: useblacksmith/stickydisk-action@master
        with:
          key: ${{ github.repository }}-npm-cache
          path: ~/.node_modules
```

Each sticky disk is uniquely identified by a key. The sticky disk will be mounted at the specified path. Once the job completes, the sticky disk will be unmounted and committed for future invocations. At the moment, customers can use up to 5 sticky disks in a single GitHub Action job.
