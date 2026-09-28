#!/usr/bin/env python3
"""Sync i18n keys from desktop source to hermes-ui."""

import re
import sys
from pathlib import Path

DESKTOP_SRC = Path('/usr/local/lib/hermes-agent/apps/desktop/src/i18n')
HERMES_UI_SRC = Path('/root/hermes-ui-repo/app/src/i18n')

def extract_i18n_keys(file_path: Path) -> dict:
    """Extract all i18n keys and their values from a TypeScript file."""
    content = file_path.read_text()
    
    # Find the export const object
    match = re.search(r'export const \w+: Translations = \{(.+)\}', content, re.DOTALL)
    if not match:
        # Try simpler pattern
        match = re.search(r'export const \w+ = \{(.+)\}', content, re.DOTALL)
    
    if not match:
        return {}
    
    # Extract key-value pairs
    keys = {}
    # Match patterns like: key: 'value', or key: (param) => `template`,
    pattern = r'(\w+(?:\.\w+)*)\s*:\s*(?:"([^"]*)"|\'([^\']*)\'|`([^`]*)`|(\w+)\s*=>\s*[`\'"].*?[`\'"]\s*[,)])'
    
    for m in re.finditer(pattern, content, re.MULTILINE):
        full_key = m.group(1)
        value = m.group(2) or m.group(3) or m.group(4) or ''
        keys[full_key] = value
    
    return keys

def get_missing_keys() -> list[str]:
    """Get missing keys from TypeScript errors."""
    import subprocess
    result = subprocess.run(
        ['npx', 'tsc', '--noEmit'],
        cwd='/root/hermes-ui-repo/app',
        capture_output=True,
        text=True
    )
    
    missing = set()
    for line in result.stdout.split('\n'):
        m = re.search(r"Property '(\w+)' does not exist", line)
        if m:
            missing.add(m.group(1))
    
    return sorted(missing)

def sync_key_to_file(key: str, desktop_values: dict):
    """Add a missing key to all i18n files."""
    # Get the value from desktop source
    desktop_val = desktop_values.get(key, '')
    
    # Update English
    en_path = HERMES_UI_SRC / 'en.ts'
    en_content = en_path.read_text()
    
    # Find where to insert - look for similar keys
    # Simple approach: add to the end of the file before the closing braces
    if key not in en_content:
        # Find the last property in the main export
        lines = en_content.split('\n')
        # Find the line with the key we're looking for context
        insert_line = len(lines)
        for i, line in enumerate(lines):
            if line.strip().startswith('};') or line.strip() == '}':
                insert_line = i
                break
        
        # Add the new key
        if isinstance(desktop_val, str):
            new_line = f"      {key}: '{desktop_val}',"
        else:
            new_line = f"      {key}: {desktop_val},"
        
        lines.insert(insert_line, new_line)
        en_path.write_text('\n'.join(lines))
        print(f"Added {key} to en.ts")

def main():
    # Get missing keys
    missing = get_missing_keys()
    print(f"Found {len(missing)} missing keys")
    
    # Extract desktop values
    en_desktop = extract_i18n_keys(DESKTOP_SRC / 'en.ts')
    
    # Sync each missing key
    for key in missing[:20]:  # Limit for now
        sync_key_to_file(key, en_desktop)
    
    print("Done syncing")

if __name__ == '__main__':
    main()
