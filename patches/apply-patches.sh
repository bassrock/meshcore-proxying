#!/bin/sh
# Apply patches to meshcore-web source tree
# Run from the meshcore-web repo root

set -e

PATCHES_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Copying WebSocketConnection.js"
cp "$PATCHES_DIR/WebSocketConnection.js" src/js/WebSocketConnection.js

echo "==> Patching src/js/Connection.js"
python3 -c "
import re

with open('src/js/Connection.js', 'r') as f:
    content = f.read()

# 1) Add import for WebSocketConnection after the NotificationUtils import
content = content.replace(
    'import NotificationUtils from \"./NotificationUtils.js\";',
    'import NotificationUtils from \"./NotificationUtils.js\";\nimport WebSocketConnection from \"./WebSocketConnection.js\";'
)

# 2) Add connectViaWebSocket method after connectViaSerial
new_method = '''

    static async connectViaWebSocket(url) {
        try {
            await this.connect(await WebSocketConnection.open(url));
            return true;
        } catch(e) {
            console.log(e);
            alert(\"failed to connect via websocket!\");
            return false;
        }
    }
'''

# Find the entire connectViaSerial method by matching through to its
# final closing braces (the method has nested return false statements)
pattern = r'(static async connectViaSerial\(\) \{.*?alert\(\"failed to connect to serial device!\"\);.*?\}\s*\})'
match = re.search(pattern, content, re.DOTALL)
if match:
    insert_pos = match.end()
    content = content[:insert_pos] + new_method + content[insert_pos:]
    print('  Added connectViaWebSocket method')
else:
    print('  WARNING: could not find connectViaSerial method to patch')

with open('src/js/Connection.js', 'w') as f:
    f.write(content)

print('  Added WebSocketConnection import')
"

echo "==> Patching src/components/connect/ConnectButtons.vue"
python3 << 'PYEOF'
import re

with open('src/components/connect/ConnectButtons.vue', 'r') as f:
    content = f.read()

# 1) Add server connect button before the closing </div>\n</template>
server_button = """
        <!-- server (websocket bridge) -->
        <button @click="connectViaServer" type="button" class="w-full flex cursor-pointer bg-green-600 rounded shadow px-3 py-2 text-white space-x-2 font-semibold hover:bg-green-700">
            <span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" class="w-6">
                    <rect width="256" height="256" fill="none"/>
                    <rect x="32" y="56" width="192" height="56" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
                    <rect x="32" y="144" width="192" height="56" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/>
                    <circle cx="68" cy="84" r="12"/>
                    <circle cx="68" cy="172" r="12"/>
                </svg>
            </span>
            <span>Connect via Server</span>
        </button>
"""

# Find the last </div> before </template> and insert button before it
content = content.replace(
    '    </div>\n</template>',
    server_button + '\n    </div>\n</template>'
)

# 2) Add the connectViaServer method after connectViaSerial
new_method = """
        async connectViaServer() {
            const wsUrl = 'ws://' + location.hostname + ':3000';
            if(await Connection.connectViaWebSocket(wsUrl)){
                this.$router.push({
                    name: "main",
                });
            }
        },"""

# Find connectViaSerial method's closing and insert after it
pattern = r'(async connectViaSerial\(\)\s*\{.*?this\.\$router\.push\(\{.*?\}\);.*?\},)'
match = re.search(pattern, content, re.DOTALL)
if match:
    insert_pos = match.end()
    content = content[:insert_pos] + new_method + content[insert_pos:]
    print('  Added connectViaServer method')
else:
    print('  WARNING: could not find connectViaSerial method to patch')

# 3) Add Connection import if not already present
if 'import Connection from' not in content and 'Connection.connectViaWebSocket' in content:
    # The import should already exist since connectViaSerial uses Connection
    pass

with open('src/components/connect/ConnectButtons.vue', 'w') as f:
    f.write(content)

print('  Added Connect via Server button')
PYEOF

echo "==> Patches applied successfully"
