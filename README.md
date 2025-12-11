# Security Patch Tool

A tool to automatically apply security patches across multiple versions of a package in a git repository.

## Setup

Install dependencies

```sh
pnpm i
```

## How It Works

Place your patches in the `patches/` directory, mirroring the target file structure.

Use this format to modify existing files:

```js
// find:
function do_nothing {
  console.log('hi')
}
// replace with:
function do_something {
  console.log('bye')
}
```

> Multiple find/replace blocks can be included in a single patch file.

Then, run the following command:

```bash
node bin.js [options] <package-name> [starting-version]
```

For example:

```bash
node bin.js --repo ~/path/to/repo @sveltejs/kit 1.5.0
node bin.js --repo ~/path/to/repo @sveltejs/kit 1.5.0-2.5.0
```

It will then:

1. Find the latest patch versions for each minor of the package name (e.g., `@sveltejs/kit@1.5.4`)
2. Check out to that version and create a new branch based on it such as `@sveltejs/kit@1.5`
3. Files from the `patches/` directory are copied over or modify existing files
4. Commits and pushes the changes

### Options

- `--repo <path>` - Path to git repository (default: current directory)
- `--dry-run` - Test patches without making changes
