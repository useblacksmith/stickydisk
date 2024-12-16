# Blacksmith Sticky Disk Action

A GitHub Action that helps persist state written to disk across jobs. Each sticky disk is hot-loaded into the runner and mounted at the specified path.
The sticky disk is formatted as an ext4 filesystem.

A common use case of this action is to cache build artifacts such as NPM packages (egs: node_modules, yarn.lock, etc) across job runs.

## Usage

```yaml
jobs:
  build:
    runs-on: blacksmith
    steps:
      - name: Cache NPM packages
        uses: useblacksmith/stickydisk@v1
        with:
          key: ${{ github.repository }}-npm-cache
          path: ~/.node_modules
```

Each sticky disk is uniquely identified by a key. The sticky disk will be mounted at the specified path. Once the job completes, the sticky disk will be unmounted and committed for future invocations. At the moment, customers can use up to 10 sticky disks in a single GitHub Action job.
