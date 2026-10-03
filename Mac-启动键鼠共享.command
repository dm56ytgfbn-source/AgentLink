#!/bin/zsh
cd "${0:A:h}" || exit 1
agentlink_node="$(command -v node)"
if [[ -z "$agentlink_node" && -x "$HOME/.local/node/bin/node" ]]; then
  agentlink_node="$HOME/.local/node/bin/node"
fi
if [[ -z "$agentlink_node" ]]; then
  print '找不到 Node.js，请先完成 AgentLink 安装。'
else
  registry="${AGENTLINK_CONFIG:-$HOME/Library/Application Support/AgentLink/config/runtime.local.json}"
  names=("${(@f)$("$agentlink_node" -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).devices||[];console.log(d.map(x=>x.name).join("\n"))' "$registry")}")
  if (( ${#names} == 0 )); then
    print '还没有配对任何电脑。请先双击「2-查找并连接电脑.command」。'
  else
    print '这台 Mac 已配对的电脑：'
    index=1
    for entry in "${names[@]}"; do
      [[ -n "$entry" ]] && print "  $index) $entry" && ((index++))
    done
    print -n '要把键鼠共享给哪一台？输入序号（直接回车 = 1）: '
    read choice
    [[ -z "$choice" ]] && choice=1
    if (( choice < 1 || choice > ${#names} )); then
      print '序号不对，没有启动。'
    else
      "$agentlink_node" scripts/start-input-share-mac.mjs "${names[$choice]}"
    fi
  fi
fi
print ''
print '共享已结束。按回车关闭此窗口。'
read -r
