#!/bin/bash

# Usage: ./patch.sh [--dry-run] [--repo <path>] [@scope/]package-name [starting-version]
# Example: ./patch.sh @sveltejs/kit
# Example: ./patch.sh @sveltejs/kit 1.5.0
# Example: ./patch.sh --dry-run @sveltejs/kit 1.5.0
# Example: ./patch.sh --repo /path/to/repo @sveltejs/kit 1.5.0

set -e  # Exit on error

# Parse flags
DRY_RUN=0
REPO_DIR=""
SHOW_PATCHES=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --show-patches)
      SHOW_PATCHES=1
      shift
      ;;
    --repo)
      REPO_DIR="$2"
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

PACKAGE="$1"
START_VERSION="${2}"

# Store the script directory for patches
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PATCH_DIR="$SCRIPT_DIR/patches"

if [ -z "$PACKAGE" ]; then
  echo "Error: Package name is required"
  echo "Usage: $0 [--dry-run] [--show-patches] [--repo <path>] [@scope/]package-name [starting-version]"
  echo ""
  echo "Options:"
  echo "  --dry-run       - Test patches without making changes"
  echo "  --show-patches  - Display parsed find/replace blocks without applying"
  echo "  --repo <path>   - Path to git repository (default: current directory)"
  echo ""
  echo "Arguments:"
  echo "  package-name    - Package to patch (required)"
  echo "  starting-version - Minimum version to start patching from (optional)"
  echo ""
  echo "Patches should be placed in the 'patches/' directory relative to this script"
  exit 1
fi

# Change to repo directory if specified
if [ -n "$REPO_DIR" ]; then
  if [ ! -d "$REPO_DIR" ]; then
    echo "Error: Repository directory not found: $REPO_DIR"
    exit 1
  fi
  echo "Changing to repository: $REPO_DIR"
  cd "$REPO_DIR"
fi

# Verify we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: Not in a git repository"
  exit 1
fi

# Function to parse and apply custom patch format
# Format:
#   // find:
#   <text to find>
#   // replace with:
#   <text to replace with>
apply_custom_patches() {
  local patch_dir="$1"
  local total_blocks=0
  local found_blocks=0
  local not_found_blocks=0
  
  # Find all files in patches directory
  find "$patch_dir" -type f | while read -r patch_file; do
    # Get the relative path from patches directory - this is the target file path
    local target_path="${patch_file#"$patch_dir"/}"
    
    echo "  Processing patch: $target_path"
    
    # Check if target file exists
    if [ ! -f "$target_path" ]; then
      # Create parent directories
      mkdir -p "$(dirname "$target_path")"
      
      if [ "$DRY_RUN" != "1" ]; then
        # For new files, just copy the patch file directly
        cp "$patch_file" "$target_path"
        echo "    ✓ File created: $target_path"
      fi
    else
      echo "    ✓ Target file exists: $target_path"
      
      # Use Node.js for reliable find/replace operations
      local result
      result=$(node -e "
        const fs = require('fs');
        const patchFile = process.argv[1];
        const targetFile = process.argv[2];
        const showPatches = process.argv[3] === '1';
        const dryRun = process.argv[4] === '1';
        
        try {
          const patchContent = fs.readFileSync(patchFile, 'utf8');
          const targetContent = fs.readFileSync(targetFile, 'utf8');
          const lines = patchContent.split('\n');
          
          let mode = null;
          let findBlock = [];
          let replaceBlock = [];
          let blocks = [];
          let blockNum = 0;
          let changesApplied = 0;
          
          // Parse patch file
          for (const line of lines) {
            if (/^\s*\/\/\s*find:\s*$/.test(line)) {
              // Save previous block if exists
              if (findBlock.length > 0) {
                blocks.push({ find: findBlock.join('\n'), replace: replaceBlock.join('\n') });
                findBlock = [];
                replaceBlock = [];
              }
              mode = 'find';
            } else if (/^\s*\/\/\s*replace\s+with:\s*$/.test(line)) {
              mode = 'replace';
            } else if (mode === 'find') {
              findBlock.push(line);
            } else if (mode === 'replace') {
              replaceBlock.push(line);
            }
          }
          
          // Save final block
          if (findBlock.length > 0) {
            blocks.push({ find: findBlock.join('\n'), replace: replaceBlock.join('\n') });
          }
          
          let modifiedContent = targetContent;
          let results = [];
          
          // Process each block
          for (const block of blocks) {
            blockNum++;
            const found = modifiedContent.includes(block.find);
            
            if (found) {
              results.push({ num: blockNum, status: 'found', find: block.find, replace: block.replace });
              
              if (!showPatches && !dryRun) {
                // Apply replacement (only first occurrence)
                const index = modifiedContent.indexOf(block.find);
                if (index !== -1) {
                  modifiedContent = modifiedContent.substring(0, index) + 
                                  block.replace + 
                                  modifiedContent.substring(index + block.find.length);
                  changesApplied++;
                }
              }
            } else {
              results.push({ num: blockNum, status: 'not_found', find: block.find });
            }
          }
          
          // Write changes if not dry run or show patches
          if (!dryRun && !showPatches && changesApplied > 0) {
            fs.writeFileSync(targetFile, modifiedContent, 'utf8');
          }
          
          console.log(JSON.stringify({ 
            success: true, 
            blocks: results, 
            changesApplied: changesApplied 
          }));
        } catch (error) {
          console.log(JSON.stringify({ 
            success: false, 
            error: error.message 
          }));
        }
      " "$patch_file" "$target_path" "$SHOW_PATCHES" "$DRY_RUN")
      
      # Parse JSON result
      local success=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).success)")
      
      if [ "$success" = "true" ]; then
        local changes_made=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).changesApplied)")
        local block_count=0
        
        # Process each block result
        while IFS= read -r block_json; do
          if [ -z "$block_json" ]; then continue; fi
          
          local block_num=$(echo "$block_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).num)")
          local status=$(echo "$block_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).status)")
          
          block_count=$((block_count + 1))
          total_blocks=$((total_blocks + 1))
          
          if [ "$status" = "found" ]; then
            found_blocks=$((found_blocks + 1))
            echo "    ✓ Block $block_num: Found in file"
            
            if [ "$SHOW_PATCHES" = "1" ]; then
              local find_text=$(echo "$block_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).find)")
              local replace_text=$(echo "$block_json" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).replace)")
              echo "      --- FIND BLOCK ---"
              echo "$find_text"
              echo "      --- REPLACE WITH ---"
              echo "$replace_text"
              echo "      --- END ---"
            elif [ "$DRY_RUN" != "1" ]; then
              echo "      Applying replacement..."
            fi
          else
            not_found_blocks=$((not_found_blocks + 1))
            echo "    ✗ Block $block_num: NOT FOUND in file"
            local find_preview=$(echo "$block_json" | node -e "const s = JSON.parse(require('fs').readFileSync(0, 'utf8')).find; console.log(s.substring(0, 100))")
            echo "      Looking for: ${find_preview}..."
          fi
        done < <(echo "$result" | node -e "JSON.parse(require('fs').readFileSync(0, 'utf8')).blocks.forEach(b => console.log(JSON.stringify(b)))")
        
        if [ "$changes_made" -gt 0 ] && [ "$DRY_RUN" != "1" ]; then
          echo "    ✓ Applied $changes_made replacement(s) to $target_path"
        fi
      else
        local error_msg=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).error)")
        echo "    ✗ Error processing patch: $error_msg"
      fi
    fi
    
    if [ "$DRY_RUN" = "1" ]; then
      echo "    Summary: $found_blocks/$total_blocks blocks found"
    fi
  done
}

# Escape special characters for sed
ESCAPED_PACKAGE=$(echo "$PACKAGE" | sed 's/[\/&]/\\&/g')

# Get list of versions to patch
VERSIONS=$(git tag -l "${PACKAGE}@*" | \
  sed "s/${ESCAPED_PACKAGE}@//" | \
  awk -F. '{print $1"."$2"."$3}' | \
  sort -t. -k1,1n -k2,2n -k3,3rn | \
  awk -F. '!seen[$1"."$2]++' | \
  sort -t. -k1,1n -k2,2n -k3,3n | \
  awk -v start="$START_VERSION" '
    BEGIN { 
      if (start != "") {
        split(start, s, ".")
        start_val = s[1] * 1000000 + s[2] * 1000 + s[3]
      } else {
        start_val = 0
      }
    }
    {
      split($0, v, ".")
      val = v[1] * 1000000 + v[2] * 1000 + v[3]
      if (val >= start_val) print
    }
  ')

echo "Found versions to patch:"
echo "$VERSIONS"
echo ""

if [ "$DRY_RUN" = "1" ]; then
  echo "=========================================="
  echo "DRY RUN MODE - No changes will be made"
  echo "=========================================="
  echo ""
fi

# Process each version
while IFS= read -r VERSION; do
  if [ -z "$VERSION" ]; then
    continue
  fi
  
  TAG="${PACKAGE}@${VERSION}"
  
  # Parse version components
  IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
  NEW_PATCH=$((PATCH + 1))
  NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"
  NEW_TAG="${PACKAGE}@${NEW_VERSION}"
  BRANCH_NAME="patch/${PACKAGE}@${NEW_VERSION}"
  
  echo "=========================================="
  echo "Processing: $TAG -> $NEW_TAG"
  echo "=========================================="
  
  # Checkout the original tag (detached HEAD) - suppress detached HEAD warning
  echo "Checking out $TAG..."
  git -c advice.detachedHead=false checkout "$TAG"
  
  # Create or switch to branch
  if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    echo "Switching to existing branch $BRANCH_NAME..."
    git checkout "$BRANCH_NAME"
  else
    echo "Creating branch $BRANCH_NAME..."
    git checkout -b "$BRANCH_NAME"
  fi
  
  # Apply your code updates
  apply_custom_patches "$PATCH_DIR"
  
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY RUN: Skipping commit/push steps"
    git checkout main 2>/dev/null || git checkout master 2>/dev/null || true
    git branch -D "$BRANCH_NAME" 2>/dev/null || true
    echo ""
    continue
  fi
  
  # Check if there are changes to commit
  if git diff --quiet; then
    echo "No changes to commit for $TAG, skipping..."
    git checkout main || git checkout master
    git branch -D "$BRANCH_NAME"
    continue
  fi
  
  # Commit changes
  echo "Committing changes..."
  git add -A
  git commit -m "Security patch for ${TAG}

Applied updates to version ${VERSION}"
  
  # Push branch
  echo "Pushing branch..."
  git push origin "$BRANCH_NAME"
  echo ""
  
done <<< "$VERSIONS"

# Return to main/master branch
echo "Returning to main branch..."
git checkout main 2>/dev/null || git checkout master 2>/dev/null || true

echo ""
echo "=========================================="
echo "All versions patched successfully!"
echo "=========================================="
