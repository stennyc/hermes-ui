#!/usr/bin/env python3
"""Add gateways alias to i18n files."""

from pathlib import Path
import re

I18N_DIR = Path('/root/hermes-ui-repo/app/src/i18n')

# Add gateways type alias after connections in types.ts
types_file = I18N_DIR / 'types.ts'
content = types_file.read_text()

# Find the connections block and add gateways alias
if 'gateways:' not in content:
    # Insert gateways alias right after connections closing brace
    # Find "connections: {" and add "gateways: connections;" or similar
    pattern = r'(    connections: \{[^}]+\})'
    match = re.search(pattern, content, re.DOTALL)
    if match:
        # Get the full connections block
        connections_block = match.group(1)
        # Create gateways block with same structure
        # Simple approach: just add "gateways" as a property that references connections
        # Actually, let's just add it as a separate object
        gateway_section = '''
    // v2 multi-connection registry: Settings → Connections (alias).
    gateways: {
      title: string
      intro: string
      stagedNote: string
      launchModeTitle: string
      launchModeDesc: string
      searchPlaceholder: string
      noSearchResults: string
      loadFailed: string
      currentPill: string
      primaryPill: string
      managedPill: string
      addConnection: string
      editConnection: string
      removeConnection: string
      removeConfirmTitle: string
      removeConfirmDesc: (label: string) => string
      makePrimary: string
      testConnection: string
      testOk: string
      testFailed: string
      saveFailed: string
      removeFailed: string
      updateAll: string
      updateAllRunning: string
      updateAllDone: string
      updateAllFailed: string
      updateSkippedCloud: string
      kindLocal: string
      kindRemote: string
      kindCloud: string
      kindSsh: string
      kindLocalDesc: string
      kindRemoteDesc: string
      kindCloudDesc: string
      kindSshDesc: string
      labelTitle: string
      labelDesc: string
    }'''
        
        # Insert after the connections block
        new_content = content[:match.end()] + gateway_section + content[match.end():]
        types_file.write_text(new_content)
        print("Added gateways to types.ts")

# Add gateways to en.ts
en_file = I18N_DIR / 'en.ts'
content = en_file.read_text()

# Find the connections block in en.ts and add gateways alias
pattern = r"(    connections: \{[\s\S]*?updateSkippedCloud: string[\s\S]*?kindCloudDesc: string[\s\S]*?kindSshDesc: string[\s\S]*?\})"
match = re.search(pattern, content)
if match:
    connections_block = match.group(1)
    # Extract all key-value pairs
    lines = connections_block.split('\n')
    # Find the closing brace position
    last_brace = -1
    for i, line in enumerate(lines):
        if line.strip() == '}':
            last_brace = i
    
    # Create gateways section
    gateways_lines = ['    // v2 multi-connection registry: Settings → Connections (alias).', '    gateways: {']
    for line in lines[1:last_brace]:  # Skip first line "connections:" and last "}"
        gateways_lines.append(line)
    gateways_lines.append('    }')
    
    gateways_block = '\n'.join(gateways_lines)
    
    # Insert after connections block
    insert_pos = match.start() + len(connections_block)
    new_content = content[:insert_pos] + '\n' + gateways_block + content[insert_pos:]
    en_file.write_text(new_content)
    print("Added gateways to en.ts")

# Check for any missing keys and add them
missing_keys = [
    ('active', 'Active'),
    ('switchTo', 'Switch to'),
    ('manage', 'Manage'),
]

for key, value in missing_keys:
    if f'{key}:' not in content:
        # Add to the gateways block
        # Find gateways block and add the key
        pattern = r"(gateways: \{[\s\S]*?kindSshDesc: string[\s\S]*?\})"
        match = re.search(pattern, content)
        if match:
            block = match.group(1)
            # Add before closing brace
            lines = block.split('\n')
            # Find the line with closing brace
            for i, line in enumerate(lines):
                if line.strip() == '}':
                    lines.insert(i, f"      {key}: '{value}',")
                    break
            new_block = '\n'.join(lines)
            new_content = content[:match.start()] + new_block + content[match.end():]
            content = new_content
            print(f"Added {key} to gateways")

en_file.write_text(content)

# Check remaining errors
print("\nDone! Check TypeScript errors now.")