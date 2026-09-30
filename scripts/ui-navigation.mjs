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
  const navigation = page.getByRole('navigation', { name: '主导航' });
  if (labels[destination]) {
    await navigation.getByRole('link', { name: labels[destination], exact: true }).click();
    return;
  }
  await navigation.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('link', { name: destination, exact: true }).first().click();
}
