/** Navigate through the visible R3.3 information architecture. */
export async function navigateUi(page, destination) {
  const labels = {
    '洞府 Home': '首页',
    '道友 Teammates': '道友',
    '队伍 Parties': '队伍',
    '历练 Missions': '历练',
    '记忆 Memory': '记忆',
    '设置 Settings': '设置',
  };
  const settingsLinks = {
    '工具与 MCP': '工具与 MCP',
    '法宝 Tools': '工具与 MCP',
    功法管理: '功法管理',
    '功法 Skills': '功法管理',
    用量记录: '用量记录',
    '灵石 Usage': '用量记录',
    本尊待办: '本尊待办',
    '本尊待办 Human Bridge': '本尊待办',
  };
  const navigation = page.getByRole('navigation', { name: '主导航' });
  if (labels[destination]) {
    await navigation.getByRole('link', { name: labels[destination], exact: true }).click();
    return;
  }
  await navigation.getByRole('link', { name: '设置', exact: true }).click();
  const link = settingsLinks[destination];
  if (!link) throw new Error(`Unknown UI navigation destination: ${destination}`);
  await page.getByRole('link', { name: link, exact: true }).click();
}
