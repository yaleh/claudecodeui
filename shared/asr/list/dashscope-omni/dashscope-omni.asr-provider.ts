/**
 * The DashScope omni recogniser's FROZEN PROMPT, as six constants and nothing else.
 *
 * WHAT THIS MODULE IS, AND WHAT IT IS NOT. It is the shipping home of the written-instruction
 * prompt the experiment selected, and it deliberately carries no `transcribe`, no `capabilities`
 * and no `id`: the wire protocol, the written-answer parse and its degradation are a later task's
 * subject, and a module that declared a capability table before it could honour one would be a
 * claim nobody could falsify. What is here is exactly the part that is frozen.
 *
 * WHY THE PROMPT IS FROZEN AT ALL. `docs/proposals/voice-dashscope-omni-written-instruction.md`
 * turned a measurement into a decision: of the six prompt conditions the experiment ran against
 * `qwen3.8-omni-flash`, the E condition — role + rules + few-shot examples as a system message, a
 * JSON two-step task as the user turn, `reasoning_effort: low` — is the one the readings support.
 * The 160 readings behind that decision (C and E, 8 clips × 10 each, all `status: 200`) are frozen
 * in `experiments/voice-omni-written/fixtures/snapshot.json`, and `scripts/asr-omni-prompt-frozen-check.mjs`
 * compares the six constants below against that snapshot SEGMENT BY SEGMENT, naming whichever one
 * moved. So the chain is: this module ≡ the frozen snapshot ≡ `experiments/voice-omni-written/raw/written.mts`,
 * the file the experiment actually sent — each link pinned, each independently readable.
 *
 * THE TEXTS BELOW ARE VERBATIM. They are the E group's `ROLE` / `RULES` / `EXAMPLES` / `JSON_TASK`
 * literals from `raw/written.mts`, character for character, including the escaped backticks inside
 * the examples (the identifiers are delimited by real backticks in the value). Editing one
 * character here is exactly what the criterion exists to catch, and it will catch it by name.
 *
 * ENVIRONMENT NEUTRALITY: no Node built-in, no ES2021+ library feature, no environment read. The
 * same property `../multimodal/multimodal.asr-provider.ts` documents, for the same reason — both
 * compiler configurations compile this file.
 */

/**
 * The version of this frozen prompt. A value, not a derivation: it names the experiment round whose
 * readings back the text below, so a future prompt that changes on purpose can be told apart from
 * a prompt that changed by accident.
 */
export const PROMPT_VERSION = 'written-e-2026-09-24';

/**
 * The role line: what the model is, what it receives, and what its output is for.
 *
 * The instruction is a WRITTEN-STYLE rewrite rather than a verbatim transcription — the measured
 * reason the C and E conditions beat the verbatim ones on this corpus.
 */
export const ROLE = '你是编码 agent 的语音指令整理器。用户对着麦克风口述了一条给编码 agent 的指令，你收到的是这段录音。你的任务不是逐字转写，而是输出一条清晰、书面化、可以直接交给编码 agent 执行的指令。';

/**
 * The six rules the rewrite obeys, in the experiment's own order and wording.
 *
 * They are one literal rather than an array of six because the experiment sent them as one string
 * and this module's job is to reproduce that string: splitting them here would be a second shape
 * for a frozen value, and the criterion compares text, not structure.
 */
export const RULES = `规则：
1. 说话人自我更正（如“嗯不对”“啊不”“不是…是…”）时，只保留更正后的意思，删掉被否定的部分。
2. 删掉口头禅和填充词（嗯、那个、就是、啊）。
3. 文件名、函数名、hook 名等代码标识符用反引号包起来，按听到的拼写写出，不要猜测或替换。
4. 数字一律用阿拉伯数字。
5. 不得添加录音里没有的信息，不得省略录音里的任何要求。
6. 只输出整理后的指令本身，不要解释。`;

/**
 * Three worked examples, spoken → written, one per rule family the experiment found load bearing
 * (a numeral rename, a self-correction, a de-disfluency that must not touch the tests).
 */
export const EXAMPLES = `示例（口述 → 整理后的指令）：
口述：嗯，那个，把 README 里的端口，就是 3000，改成八千零八十
指令：把 \`README\` 里的端口从 3000 改成 8080。
口述：给 login 页面加个校验，啊不对，是 signup 页面
指令：给 signup 页面加上校验。
口述：删掉 utils 目录下那个 date 的 helper，嗯，别动测试
指令：删掉 \`utils\` 目录下的 date helper，不要改动测试。`;

/**
 * The user turn: a two-step task (transcribe, then rewrite) whose answer is one JSON object.
 *
 * It is a constant of its own rather than a sentence appended to the role, because the experiment
 * varied exactly this — D and E differ from C by this turn — and the criterion compares this
 * segment by name.
 */
export const JSON_TASK = '先逐字转写录音，再按规则整理成指令。只输出一个 JSON 对象：{"transcript": "逐字转写", "instruction": "整理后的指令"}，不要输出其他内容。';

/**
 * The thinking budget the E condition was run at, and the value the frozen readings were taken
 * under. `low` is the one that was measured; raising it changes the latency and the answer shape
 * without a reading behind it.
 */
export const REASONING_EFFORT = 'low';

/**
 * The model the frozen readings came from.
 *
 * A DashScope ALIAS, not an immutable snapshot: the service is free to re-point it, so a future
 * reading taken under the same name may differ from these 160. That is recorded in the snapshot's
 * provenance rather than hidden here — the constant says which name the experiment used, not that
 * the name still resolves to the same weights.
 */
export const DEFAULT_MODEL = 'qwen3.8-omni-flash';
