// core-3a：分類測試集（40 題，待真人複核）。題目是自己寫的、像使用者會打給 Claude 的請求，沒有用任何人的真實對話。
// 每題的 action／subject 是我認為正確的代碼（只能用 taxonomy.ts 清單內的），reviewed: false＝還沒有真人複核（主人規定測試標準不能只靠一個人或一個模型）。
// 本來要放 classify-40.json，但外掛測試只能 import 程式檔（.json 會被引擎拒絕），也讀不到真的檔案，所以寫成 .ts。
import type { Action, Lang, Subject } from '../../hooks/taxonomy'

// 代碼用 taxonomy 的型別：標錯代碼時 tsc 就會報錯
export type ClassifyCase = { id: string; lang: Lang; prompt: string; action: Action; subject: Subject; reviewed: boolean }

export const CLASSIFY_40: ClassifyCase[] = [
  { id: 'c01', lang: 'en', prompt: 'Add a dark mode toggle to the settings page of my React site', action: 'building-features', subject: 'website', reviewed: false },
  { id: 'c02', lang: 'en', prompt: 'The login button on my portfolio site does nothing on Safari, can you figure out why?', action: 'fixing-bugs', subject: 'website', reviewed: false },
  { id: 'c03', lang: 'en', prompt: 'Split this 900-line Express server file into routes and services without changing behavior', action: 'refactoring', subject: 'backend', reviewed: false },
  { id: 'c04', lang: 'en', prompt: 'Write unit tests for the cart total function in my shop app', action: 'writing-tests', subject: 'app', reviewed: false },
  { id: 'c05', lang: 'en', prompt: 'Compare SQLite and Postgres for a small side project API and tell me which to pick', action: 'researching', subject: 'backend', reviewed: false },
  { id: 'c06', lang: 'en', prompt: "Explain how React useEffect cleanup works, I'm still learning", action: 'learning', subject: 'website', reviewed: false },
  { id: 'c07', lang: 'en', prompt: 'Write a README for my Discord bot explaining setup and commands', action: 'writing-docs', subject: 'automation', reviewed: false },
  { id: 'c08', lang: 'en', prompt: 'Sketch the screen layout for a habit tracker mobile app', action: 'designing', subject: 'app', reviewed: false },
  { id: 'c09', lang: 'en', prompt: 'Help me break my Unity platformer into milestones for the next month', action: 'planning', subject: 'game', reviewed: false },
  { id: 'c10', lang: 'en', prompt: 'Load this CSV of monthly sales and tell me which product grew fastest', action: 'analyzing-data', subject: 'data', reviewed: false },
  { id: 'c11', lang: 'en', prompt: 'Set up Python, a virtualenv and VS Code on my new laptop', action: 'setting-up', subject: 'dev-environment', reviewed: false },
  { id: 'c12', lang: 'en', prompt: 'Review my pull request for the payment webhook handler and point out risks', action: 'reviewing', subject: 'backend', reviewed: false },
  { id: 'c13', lang: 'en', prompt: 'My agent keeps calling the search tool in a loop, why?', action: 'fixing-bugs', subject: 'ai-agent', reviewed: false },
  { id: 'c14', lang: 'en', prompt: 'Build a script that renames my vacation photos by date taken', action: 'building-features', subject: 'automation', reviewed: false },
  { id: 'c15', lang: 'en', prompt: 'Proofread my cover letter and make it sound more confident', action: 'reviewing', subject: 'document', reviewed: false },
  { id: 'c16', lang: 'en', prompt: 'Help me understand recursion for my CS101 homework', action: 'learning', subject: 'coursework', reviewed: false },
  { id: 'c17', lang: 'en', prompt: 'Generate a color palette and title card for my YouTube channel intro', action: 'designing', subject: 'creative-media', reviewed: false },
  { id: 'c18', lang: 'en', prompt: 'Add a double-jump power-up to my Godot game', action: 'building-features', subject: 'game', reviewed: false },
  { id: 'c19', lang: 'en', prompt: 'Configure ESLint and Prettier so they stop fighting in my monorepo', action: 'setting-up', subject: 'dev-environment', reviewed: false },
  { id: 'c20', lang: 'en', prompt: "What's a good name for my cat?", action: 'other', subject: 'other', reviewed: false },
  { id: 'c21', lang: 'zh-TW', prompt: '幫我在網站首頁加一個訂閱電子報的表單', action: 'building-features', subject: 'website', reviewed: false },
  { id: 'c22', lang: 'zh-TW', prompt: 'App 在 Android 上一打開就閃退，幫我看 log 找原因', action: 'fixing-bugs', subject: 'app', reviewed: false },
  { id: 'c23', lang: 'zh-TW', prompt: '把這個重複很多的資料庫查詢整理成共用函式，行為不要變', action: 'refactoring', subject: 'backend', reviewed: false },
  { id: 'c24', lang: 'zh-TW', prompt: '幫我的爬蟲腳本補測試，特別是網頁格式改掉的情況', action: 'writing-tests', subject: 'automation', reviewed: false },
  { id: 'c25', lang: 'zh-TW', prompt: '查一下現在做聊天機器人有哪些開源框架，比較優缺點', action: 'researching', subject: 'ai-agent', reviewed: false },
  { id: 'c26', lang: 'zh-TW', prompt: '我想學 SQL 的 JOIN，用簡單的例子教我', action: 'learning', subject: 'data', reviewed: false },
  { id: 'c27', lang: 'zh-TW', prompt: '幫我把這份 API 的使用說明寫成文件', action: 'writing-docs', subject: 'backend', reviewed: false },
  { id: 'c28', lang: 'zh-TW', prompt: '幫我設計遊戲角色升級的數值系統', action: 'designing', subject: 'game', reviewed: false },
  { id: 'c29', lang: 'zh-TW', prompt: '我下禮拜要交期末專題，幫我排每天要做什麼', action: 'planning', subject: 'coursework', reviewed: false },
  { id: 'c30', lang: 'zh-TW', prompt: '分析這份問卷結果，看不同年齡層的滿意度差多少', action: 'analyzing-data', subject: 'data', reviewed: false },
  { id: 'c31', lang: 'zh-TW', prompt: '幫我在 Windows 上裝 Node 和 Git，設定好環境變數', action: 'setting-up', subject: 'dev-environment', reviewed: false },
  { id: 'c32', lang: 'zh-TW', prompt: '幫我看看這篇報告的邏輯有沒有問題', action: 'reviewing', subject: 'document', reviewed: false },
  { id: 'c33', lang: 'zh-TW', prompt: '我的 AI 助理回答都太長了，幫我調 prompt 讓它短一點', action: 'fixing-bugs', subject: 'ai-agent', reviewed: false },
  { id: 'c34', lang: 'zh-TW', prompt: '幫我寫一首關於秋天的歌詞', action: 'other', subject: 'creative-media', reviewed: false },
  { id: 'c35', lang: 'zh-TW', prompt: '整理一下這個 LINE bot 的程式結構，現在全部塞在一個檔案', action: 'refactoring', subject: 'automation', reviewed: false },
  { id: 'c36', lang: 'zh-TW', prompt: '幫我規劃個人網站要有哪些頁面', action: 'planning', subject: 'website', reviewed: false },
  { id: 'c37', lang: 'zh-TW', prompt: '教我 Git rebase 跟 merge 差在哪', action: 'learning', subject: 'dev-environment', reviewed: false },
  { id: 'c38', lang: 'zh-TW', prompt: '幫我把會議紀錄整理成重點', action: 'writing-docs', subject: 'document', reviewed: false },
  { id: 'c39', lang: 'zh-TW', prompt: '幫 Flutter app 的登入流程寫整合測試', action: 'writing-tests', subject: 'app', reviewed: false },
  { id: 'c40', lang: 'zh-TW', prompt: '今天晚餐吃什麼好？', action: 'other', subject: 'other', reviewed: false },
]
