# 来源业务约定
当前已运行的业务范围：领取一个月份的原始费用清单，按运单汇集费用行并给出月度收件总额。
以下约定描述合作源接口及其返回含义，不表示工作台已经办理了所有来源状态。
## `GET /statements/:month`
返回statementId、lines及adjustmentRefs；lines的feeId为收费身份，不是运单身份。
## `GET /adjustments/:id`
返回凭据原额、状态及applicationRefs；应用明细按applicationId单独标识。
## `GET /applications/:id`
返回凭据对具体statementId的抵扣额或冲回额，可暂时不可用。
## 本地传输
本地来源按请求方法和路径匹配，查询和正文不参与路由匹配。响应脚本只负责返回来源原始数据，不替工作台判断业务是否完成。`delayMs` 为本次响应延迟，`disconnect` 表示未返回确定响应便断开连接，`status` 为 HTTP 状态；记录顺序与实际请求一致。来源实例独享响应进度，重新启动恢复第一条。
业务标识区分大小写；金额为最小货币单位的整数，时间为本地来源统一的整数秒。样例中的身份、合同和公司均为合成资料，不是外部系统账号。

## 本地可读资源
`GET /adjustments/V1` 返回该资源的合成业务资料；正常样例中的身份与主领取记录一致。
`GET /applications/AP1` 返回该资源的合成业务资料；正常样例中的身份与主领取记录一致。
`GET /applications/AP2` 返回该资源的合成业务资料；正常样例中的身份与主领取记录一致。

来源路径可包含具名段，按段匹配。`requireBody` 与 `requireQuery` 可限制业务范围，不符合时返回409且不推进响应序列；`requireAuthentication` 表示该路由要求授权。`GET /counters` 只返回来源处理次数，不参与收件决策。
