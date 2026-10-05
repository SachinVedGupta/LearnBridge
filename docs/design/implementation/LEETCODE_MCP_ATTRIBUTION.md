# LeetCode MCP source audit and attribution

LearnBridge bundles its own eight-tool **read-only stdio MCP** using the existing MCP SDK. It does not install or run either upstream package, start an HTTP MCP server, expose their write tools, retrieve editorials or execute students' code.

Query field shapes and the local session-cookie/CSRF authentication flow were adapted after reviewing these MIT sources on 5 October 2026:

- [jinzcdev/leetcode-mcp-server](https://github.com/jinzcdev/leetcode-mcp-server), version **1.4.0**, audited commit [`126115fc6e89e60125474e721d985afdf159c55f`](https://github.com/jinzcdev/leetcode-mcp-server/tree/126115fc6e89e60125474e721d985afdf159c55f). The npm version's `gitHead` matches this commit. [User tools](https://github.com/jinzcdev/leetcode-mcp-server/blob/126115fc6e89e60125474e721d985afdf159c55f/src/mcp/tools/user-tools.ts), [global service](https://github.com/jinzcdev/leetcode-mcp-server/blob/126115fc6e89e60125474e721d985afdf159c55f/src/leetcode/leetcode-global-service.ts) and [search query](https://github.com/jinzcdev/leetcode-mcp-server/blob/126115fc6e89e60125474e721d985afdf159c55f/src/leetcode/graphql/global/search-problems.ts) were reviewed as source, without running upstream code.
- [JacobLinCool/LeetCode-Query](https://github.com/JacobLinCool/LeetCode-Query), the pinned upstream dependency **2.0.1**. Its published package was downloaded for static inspection only. [Published version](https://www.npmjs.com/package/leetcode-query/v/2.0.1) uses session and CSRF cookies against LeetCode GraphQL; its submission-detail query includes code and judge evidence.

The external MCP registers `run_code` and `submit_solution` for authenticated accounts. Those are side-effecting operations and are absent from LearnBridge. The external query library discards global `hasNext` metadata and normalizes private history timestamps differently from public recent history. LearnBridge retains page coverage and normalizes GraphQL epoch seconds consistently. Public recent attempts can have no IDs, code or complete history. A bounded private page is not a full-account audit. Runtime and memory percentiles are judge measurements, not scores for student understanding.

LearnBridge currently supports **leetcode.com only**, at the fixed `https://leetcode.com/graphql/` destination. The local **Sign in to LeetCode** flow opens a dedicated visible Chrome window for normal student-controlled sign-in, social login and MFA. This is not third-party OAuth: no documented LeetCode third-party OAuth delegation endpoint was found in the reviewed MCP implementation. Chrome retains its own sign-in in a private marked profile beside the workspace, outside Git, SQLite and LearnBridge backups. LearnBridge does not read an existing browser profile or fill login credentials. Disconnect stops the owned browser and retains its profile; explicit **Forget saved sign-in** removes only that validated owned profile.

After separate account consent, the local adapter checks the current owned top frame and security state, then reads only its secure HTTP-only `LEETCODE_SESSION` cookie for `https://leetcode.com/`. The cookie value remains transient in the local service and private MCP child; it never enters dashboard JSON, database records, ordinary logs or the hosted website. CSRF initialization uses the fixed GraphQL destination. Epoch changes discard in-flight authorization after navigation or closure. Expiry, denial, rate limits and changes to this unofficial website API stop the read; there is no CAPTCHA or access-control bypass.

The bundled client passed live anonymous profile and Two Sum statement reads. A real dedicated Chrome window opened the fixed login page and enforced the unsigned-in gate, then shut down and erased its disposable smoke profile. Synthetic transport and browser tests cover private history/code reads, cookie validation, persistence and revocation; those tests do not establish a successful real student sign-in or private-account read.

## MIT notices

MIT License

Copyright (c) 2025 jinzc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

MIT License

Copyright (c) 2021 JacobLinCool

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
