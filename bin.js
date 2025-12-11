#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse command line arguments
 * @returns {{dryRun: boolean, repoDir: string, package: string, startVersion: string}} - Parsed command line options
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    repoDir: "",
    package: "",
    startVersion: "",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--repo":
        options.repoDir = args[++i];
        break;
      default:
        if (!options.package) {
          options.package = args[i];
        } else if (!options.startVersion) {
          options.startVersion = args[i];
        }
        break;
    }
  }

  return options;
}

/**
 * Display usage information
 * @returns {void}
 */
function showUsage() {
  console.log(
    "Usage: patchy [--dry-run] [--repo <path>] [@scope/]package-name [starting-version]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --dry-run       - Test patches without making changes (shows patch details)");
  console.log(
    "  --repo <path>   - Path to git repository (default: current directory)",
  );
  console.log("");
  console.log("Arguments:");
  console.log("  package-name    - Package to patch (required)");
  console.log(
    "  starting-version - Minimum version to start patching from (optional)",
  );
  console.log("");
  console.log(
    "Patches should be placed in the 'patches/' directory relative to this script",
  );
}

// Execute git command
/**
 * @typedef {Object} GitOptions
 * @property {boolean} [quiet] - Whether to suppress output
 * @property {boolean} [allowError] - Whether to allow errors without throwing
 * @property {'pipe' | 'inherit' | 'ignore'} [stdio] - Standard I/O configuration
 */

/**
 * Execute git command
 * @param {string} command - Git command to execute
 * @param {GitOptions} [options] - Execution options
 * @returns {string} - Command output
 */
function git(command, options = {}) {
  try {
    return execSync(`git ${command}`, {
      encoding: "utf8",
      stdio: options.quiet ? "pipe" : "inherit",
      ...options,
    });
  } catch (error) {
    if (options.allowError) {
      return "";
    }
    throw error;
  }
}

/**
 * Parse and apply custom patches from a directory
 * @param {string} patchDir - Directory containing patch files
 * @param {boolean} dryRun - Whether to run without making changes (also shows patch details)
 * @returns {void}
 */
function applyCustomPatches(patchDir, dryRun) {
  let totalBlocks = 0;
  let foundBlocks = 0;
  let notFoundBlocks = 0;

  /**
   * Recursively find all files in a directory
   * @param {string} dir - Directory to search
   * @param {string} [base=''] - Base path for relative paths
   * @returns {{patchPath: string, targetPath: string}[]} - Array of file path objects
   */
  const findFiles = (dir, base = "") => {
    const files = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(base, entry.name);

      if (entry.isDirectory()) {
        files.push(...findFiles(fullPath, relativePath));
      } else {
        files.push({ patchPath: fullPath, targetPath: relativePath });
      }
    }

    return files;
  };

  const patchFiles = findFiles(patchDir);

  for (const { patchPath, targetPath } of patchFiles) {
    console.log(`  Processing patch: ${targetPath}`);

    // Check if target file exists
    if (!fs.existsSync(targetPath)) {
      // Create parent directories
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      if (!dryRun) {
        // For new files, read patch content, replace $CURRENT_BRANCH, then write
        const currentBranch = git("rev-parse --abbrev-ref HEAD", {
          quiet: true,
          stdio: "pipe",
        }).trim();
        const patchContent = fs.readFileSync(patchPath, "utf8");
        const contentToWrite = patchContent.replace(/\$CURRENT_BRANCH/g, currentBranch);
        
        fs.writeFileSync(targetPath, contentToWrite, "utf8");
        console.log(styleText('green', `    ✓ File created: ${targetPath}`));
      }
    } else {
      console.log(styleText('green', `    ✓ Target file exists: ${targetPath}`));

      // Parse and apply patches
      const patchContent = fs.readFileSync(patchPath, "utf8");
      const targetContent = fs.readFileSync(targetPath, "utf8");
      const lines = patchContent.split("\n");

      let mode = null;
      let findBlock = [];
      let replaceBlock = [];
      const blocks = [];

      // Parse patch file
      for (const line of lines) {
        if (/^\s*\/\/\s*find:\s*$/.test(line)) {
          // Save previous block if exists
          if (findBlock.length > 0) {
            blocks.push({
              find: findBlock.join("\n"),
              replace: replaceBlock.join("\n"),
            });
            findBlock = [];
            replaceBlock = [];
          }
          mode = "find";
        } else if (/^\s*\/\/\s*replace\s+with:\s*$/.test(line)) {
          mode = "replace";
        } else if (mode === "find") {
          findBlock.push(line);
        } else if (mode === "replace") {
          replaceBlock.push(line);
        }
      }

      // Save final block
      if (findBlock.length > 0) {
        blocks.push({
          find: findBlock.join("\n"),
          replace: replaceBlock.join("\n"),
        });
      }

      let modifiedContent = targetContent;
      let changesApplied = 0;

      // If no find/replace blocks found, overwrite the file entirely
      if (blocks.length === 0) {
        totalBlocks++;
        foundBlocks++;
        console.log(
          styleText('yellow', '    ✓ No find/replace blocks found - overwriting entire file'),
        );

        if (!dryRun) {
          // Get current branch name and replace $CURRENT_BRANCH placeholder
          const currentBranch = git("rev-parse --abbrev-ref HEAD", {
            quiet: true,
            stdio: "pipe",
          }).trim();
          const contentToWrite = patchContent.replace(/\$CURRENT_BRANCH/g, currentBranch);
          
          fs.writeFileSync(targetPath, contentToWrite, "utf8");
          console.log("      File overwritten with patch content");
          changesApplied = 1;
        }
      } else {
        // Process each block
        let blockNum = 0;
        for (const block of blocks) {
          blockNum++;
          totalBlocks++;
          const found = modifiedContent.includes(block.find);

          if (found) {
            foundBlocks++;
            console.log(styleText('green', `    ✓ Block ${blockNum}: Found in file`));

            if (dryRun) {
              console.log("      --- FIND BLOCK ---");
              console.log(block.find);
              console.log("      --- REPLACE WITH ---");
              console.log(block.replace);
              console.log("      --- END ---");
            } else {
              // Apply replacement (only first occurrence)
              const index = modifiedContent.indexOf(block.find);
              if (index !== -1) {
                modifiedContent =
                  modifiedContent.substring(0, index) +
                  block.replace +
                  modifiedContent.substring(index + block.find.length);
                changesApplied++;
                console.log("      Applying replacement...");
              }
            }
          } else {
            notFoundBlocks++;
            console.log(styleText('red', `    ✗ Block ${blockNum}: NOT FOUND in file`));
            const findPreview = block.find.substring(0, 100);
            console.log(styleText('gray', `      Looking for: ${findPreview}...`));
          }
        }

        // Write changes if not dry run
        if (!dryRun && changesApplied > 0) {
          // Get current branch name and replace $CURRENT_BRANCH placeholder
          const currentBranch = git("rev-parse --abbrev-ref HEAD", {
            quiet: true,
            stdio: "pipe",
          }).trim();
          const finalContent = modifiedContent.replace(/\$CURRENT_BRANCH/g, currentBranch);
          
          fs.writeFileSync(targetPath, finalContent, "utf8");
          console.log(
            styleText('green', `    ✓ Applied ${changesApplied} replacement(s) to ${targetPath}`),
          );
        }
      }
    }

    if (dryRun) {
      console.log(styleText('cyan', `    Summary: ${foundBlocks}/${totalBlocks} blocks found`));
    }
  }
}

/**
 * Compare two semantic version strings
 * @param {string} v1 - First version to compare
 * @param {string} v2 - Second version to compare
 * @returns {number} - Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }
  return 0;
}

/**
 * Get list of versions to patch for a given package
 * @param {string} packageName - Name of the package to get versions for
 * @param {string} startVersion - Minimum version to start from (optional)
 * @returns {string[]} - Array of version strings to patch
 */
function getVersionsToPatch(packageName, startVersion) {
  // Get all tags for the package
  const tags = git(`tag -l "${packageName}@*"`, { quiet: true, stdio: "pipe" })
    .trim()
    .split("\n")
    .filter((tag) => tag);

  // Extract versions
  const versions = tags
    .map((tag) => tag.replace(`${packageName}@`, ""))
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version));

  // Group by major.minor and keep highest patch for each
  const versionMap = new Map();
  for (const version of versions) {
    const [major, minor, patch] = version.split(".").map(Number);
    const key = `${major}.${minor}`;

    if (!versionMap.has(key) || patch > versionMap.get(key).patch) {
      versionMap.set(key, { major, minor, patch, version });
    }
  }

  // Convert back to array and sort
  let filteredVersions = Array.from(versionMap.values())
    .map((v) => v.version)
    .sort((a, b) => {
      const [maj1, min1, pat1] = a.split(".").map(Number);
      const [maj2, min2, pat2] = b.split(".").map(Number);
      return maj1 - maj2 || min1 - min2 || pat1 - pat2;
    });

  // Filter by start version
  if (startVersion) {
    filteredVersions = filteredVersions.filter(
      (v) => compareVersions(v, startVersion) >= 0,
    );
  }

  return filteredVersions;
}

/**
 * Main function to orchestrate the patching process
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs();

  if (!options.package) {
    console.error(styleText('red', 'Error: Package name is required'));
    console.log("");
    showUsage();
    process.exit(1);
  }

  const scriptDir = __dirname;
  const patchDir = path.join(scriptDir, "patches");

  // Change to repo directory if specified
  if (options.repoDir) {
    if (!fs.existsSync(options.repoDir)) {
      console.error(
        styleText('red', `Error: Repository directory not found: ${options.repoDir}`),
      );
      process.exit(1);
    }
    console.log(`Changing to repository: ${options.repoDir}`);
    process.chdir(options.repoDir);
  }

  // Verify we're in a git repository
  try {
    git("rev-parse --git-dir", { quiet: true, stdio: "pipe" });
  } catch (error) {
    console.error(styleText('red', 'Error: Not in a git repository'));
    process.exit(1);
  }

  // Get versions to patch
  const versions = getVersionsToPatch(options.package, options.startVersion);

  console.log(styleText('cyan', 'Found versions to patch:'));
  console.log(versions.join("\n"));
  console.log("");

  if (options.dryRun) {
    console.log(styleText('yellow', '=========================================='));
    console.log(styleText('yellow', 'DRY RUN MODE - No changes will be made'));
    console.log(styleText('yellow', '=========================================='));
    console.log("");
  }

  // Process each version
  for (const version of versions) {
    const tag = `${options.package}@${version}`;
    const [major, minor, patch] = version.split(".").map(Number);
    const newPatch = patch + 1;
    const newVersion = `${major}.${minor}.${newPatch}`;
    const newTag = `${options.package}@${newVersion}`;
    const branchName = `${options.package}@${major}.${minor}`;

    console.log(styleText('cyan', '=========================================='));
    console.log(styleText('cyan', `Processing: ${tag} -> ${newTag}`));
    console.log(styleText('cyan', '=========================================='));

    // Checkout the original tag (detached HEAD)
    console.log(`Checking out ${tag}...`);
    git(`-c advice.detachedHead=false checkout "${tag}"`, { quiet: true });

    // Create or switch to branch
    const branchExists = git(`show-ref --verify refs/heads/${branchName}`, {
      quiet: true,
      allowError: true,
      stdio: "pipe",
    });

    if (branchExists) {
      console.log(`Switching to existing branch ${branchName}...`);
      git(`checkout "${branchName}"`, { quiet: true });
    } else {
      console.log(`Creating branch ${branchName}...`);
      git(`checkout -b "${branchName}"`, { quiet: true });
    }

    // Apply patches
    applyCustomPatches(patchDir, options.dryRun);

    if (options.dryRun) {
      console.log(styleText('yellow', 'DRY RUN: Skipping commit/push steps'));
      try {
        git("checkout main", { quiet: true, allowError: true });
      } catch {
        try {
          git("checkout master", { quiet: true, allowError: true });
        } catch {
          // Ignore
        }
      }
      git(`branch -D "${branchName}"`, { quiet: true, allowError: true });
      console.log("");
      continue;
    }

    // Check if there are changes to commit
    // git diff --quiet returns empty string (falsy) when there ARE changes
    const noDiff = git("diff --quiet", {
      quiet: true,
      allowError: true,
      stdio: "pipe",
    });

    if (noDiff) {
      console.log(styleText('gray', `No changes to commit for ${tag}, skipping...`));
      try {
        git("checkout main", { quiet: true, allowError: true });
      } catch {
        git("checkout master", { quiet: true, allowError: true });
      }
      git(`branch -D "${branchName}"`, { quiet: true, allowError: true });
      continue;
    }

    // Commit changes
    console.log("Committing changes...");
    git("add -A");
    git(
      `commit -m "Security patch for ${tag}\n\nApplied updates to version ${version}"`,
    );

    // Push branch
    console.log("Pushing branch...");
    git(`push origin "${branchName}"`);
    console.log("");
  }

  // Return to main/master branch
  console.log("Returning to main branch...");
  try {
    git("checkout main", { quiet: true, allowError: true });
  } catch {
    try {
      git("checkout master", { quiet: true, allowError: true });
    } catch {
      // Ignore
    }
  }

  console.log("");
  console.log(styleText('green', '=========================================='));
  console.log(styleText('green', 'All versions patched successfully!'));
  console.log(styleText('green', '=========================================='));
}

// Run main function
main().catch((error) => {
  console.error(styleText('red', 'Error:'), error.message);
  process.exit(1);
});
