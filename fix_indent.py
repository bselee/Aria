#!/usr/bin/env python3
"""Fix deeply-indented banner in ActivePurchasesPanel.tsx."""

with open('src/components/dashboard/ActivePurchasesPanel.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the banner comment line
banner_idx = None
for i, line in enumerate(lines):
    if 'Aggregate Status Banner' in line and '/*' in line:
        banner_idx = i
        break

if banner_idx is None:
    print('ERROR: Could not find banner comment')
    exit(1)

print(f'Banner found at line {banner_idx + 1}')
ws = len(lines[banner_idx]) - len(lines[banner_idx].lstrip())
print(f'Current indent: {ws} spaces')

if ws <= 20:
    print('Indent already correct. No changes needed.')
    # Check the loading line too
    for j in range(banner_idx, min(banner_idx + 40, len(lines))):
        if 'Loading active purchases' in lines[j]:
            ws2 = len(lines[j]) - len(lines[j].lstrip())
            print(f'Loading text indent: {ws2} spaces')
    exit(0)

# Find the range from banner through loading and ) : error ? (
end_idx = None
for j in range(banner_idx, min(banner_idx + 50, len(lines))):
    if ') : error ? (' in lines[j] or ') : error ? (' in lines[j]:
        end_idx = j
        break

if end_idx is None:
    print('ERROR: Could not find end of loading block')
    exit(1)

print(f'Block from line {banner_idx + 1} to {end_idx + 1}')

# Calculate the indent reduction
reduction = ws - 20
if reduction <= 0:
    print(f'Indent is only {ws}, no reduction needed')
    exit(0)

print(f'Reducing indent by {reduction} spaces')

# Apply indent reduction to the block
for j in range(banner_idx, end_idx + 1):
    lines[j] = lines[j][reduction:]

with open('src/components/dashboard/ActivePurchasesPanel.tsx', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print('Done! Indent fixed.')