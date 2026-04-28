#!/usr/bin/env python3
"""
Version update script for Kinesis/Genesis Tauri app.

Usage: python3 updateVersion.py <new_version>

This script updates the version in the following files:
- package.json (top-level version only)
- src-tauri/tauri.conf.json (top-level version only)
- src-tauri/Cargo.toml (package version only)
- src-tauri/src/lib.rs (VERSION constant)
"""

import sys
import re
import os
import json

def update_json_file(filepath, new_version):
    """Update the top-level 'version' field in a JSON file."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)

        if 'version' in data:
            data['version'] = new_version
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            print(f"Updated {filepath}")
        else:
            print(f"No 'version' field found in {filepath}")

    except Exception as e:
        print(f"Error updating {filepath}: {e}")

def update_file(filepath, pattern, replacement, flags=0):
    """Update a file by replacing a regex pattern."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        original_content = content
        content = re.sub(pattern, replacement, content, flags=flags)

        if content != original_content:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            print(f"Updated {filepath}")
        else:
            print(f"No changes needed in {filepath}")

    except Exception as e:
        print(f"Error updating {filepath}: {e}")

def main():
    if len(sys.argv) != 2:
        print("Usage: python3 updateVersion.py <new_version>")
        sys.exit(1)

    new_version = sys.argv[1]

    # Validate version format (basic check)
    if not re.match(r'^\d+\.\d+\.\d+$', new_version):
        print(f"Warning: Version '{new_version}' doesn't match typical x.y.z format")

    # Check if we're in the right directory
    if not os.path.exists('package.json') or not os.path.exists('src-tauri'):
        print("Error: This script must be run from the project root directory")
        sys.exit(1)

    print(f"Updating version to {new_version}")

    # Update JSON files (safe, only top-level version)
    update_json_file('package.json', new_version)
    update_json_file('src-tauri/tauri.conf.json', new_version)

    # Update Cargo.toml: only the version under [package]
    # Pattern matches 'version = "..."' that comes after '[package]' and before next '['
    update_file('src-tauri/Cargo.toml',
                r'(\[package\][^[]*version\s*=\s*)"[^"]*"',
                rf'\1"{new_version}"',
                re.DOTALL)

    # Update lib.rs: const VERSION: &str = "...";
    update_file('src-tauri/src/lib.rs',
                r'(const VERSION:\s*&str\s*=\s*)"[^"]*"',
                rf'\1"{new_version}"')

    print("\nVersion update complete!")
    print("Note: Run 'npm install' and 'cargo check' to update lock files if needed.")

if __name__ == '__main__':
    main()