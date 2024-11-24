# Delete Blacksmith Cache Action

A GitHub Action to delete caches from Blacksmith's cache storage. This action allows you to delete either a specific cache version or all versions of a cache key.

## Usage

```yaml
- name: Delete Cache
  uses: useblacksmith/cache-delete@v1
  with:
    key: Linux-composer-ecf6e2e236589e4d34ba89662b6bc2afe8e15237cd19a13df9dc0cb599ff4826
    version: v213asda2cf # Optional: specific version to delete
```

## Inputs

| Input     | Description                             | Required |
| --------- | --------------------------------------- | -------- |
| `key`     | The cache key to delete                 | Yes      |
| `version` | Specific version of the cache to delete | No       |

## Examples

### Delete All Versions of a Cache

```yaml
- name: Delete All Cache Versions
  uses: useblacksmith/cache-delete@v1
  with:
    key: npm-cache
```

### Delete a Specific Cache Version

```yaml
- name: Delete Specific Cache Version
  uses: useblacksmith/cache-delete@v1
  with:
    key: npm-cache
    version: v1.0
```

## Error Handling

The action will:

- Fail if the cache deletion request fails (non-404 error)
- Log a message if the cache is not found (404)
- Successfully complete if the cache is deleted

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
