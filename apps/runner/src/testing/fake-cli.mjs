// 测试替身 CLI：按 FAKE_CLI_LINES（JSON 数组 [{delay_ms, line}]）逐条往 stdout 写，最后以 FAKE_CLI_EXIT 退出。
const lines = JSON.parse(process.env.FAKE_CLI_LINES ?? "[]");
const exitCode = Number(process.env.FAKE_CLI_EXIT ?? "0");

async function main() {
  for (const item of lines) {
    await new Promise((r) => setTimeout(r, item.delay_ms ?? 0));
    process.stdout.write(String(item.line) + "\n");
  }
  process.exit(exitCode);
}
main();
