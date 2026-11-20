# 来源业务约定
当前业务范围：逐月领取承运商原始费用清单，并把针对错收费用的调整凭据、逐笔抵扣应用及其实际结算去向一并收进账单收件台。
以下约定描述合作源接口及其返回含义，不表示工作台已经办理了所有来源状态。
## `GET /statements/:month`
返回statementId、month、lines及adjustmentRefs；lines的feeId为收费身份，不是运单身份；adjustmentRefs是该清单引用的调整凭据身份列表。抵扣只通过凭据与应用登记，不修改lines中的原始金额。
## `GET /adjustments/:id`
返回凭据原额amount、归属费用行feeId、状态status、凭据开立时间issuedAt（整数秒）及applicationRefs；应用明细按applicationId单独标识。
status含义：
- `issued`：已开立，可按应用明细分次抵扣；
- `appealed`：抵扣申请仍在申诉，工作台只登记状态与已应用额，不裁决争议费用是否合理；
- `withdrawn`：凭据被撤回且未使用，不得存在任何已应用抵扣；
- `reversed`：曾经使用后又冲回，apply与reverse两类应用必须同时保留。
## `GET /applications/:id`
返回某张凭据对具体statementId的一笔抵扣（kind=`apply`）或冲回（kind=`reverse`），含金额与结算应用时间appliedAt（整数秒）。同一凭据可分多次应用到多张结算单；该资源可暂时不可用（拒答、超时或结构缺失），此时工作台登记缺口并保持待核实，不按凭据总额倒推配平。
## 三个期间的区分
- 费用发生期：费用行所在statement的month；
- 凭据开立期：adjustment的issuedAt所属月份；
- 结算应用期：application的appliedAt所属月份。
三者分别归集，互不覆盖；二月清单的抵扣总额不等于二月每票运费的减少额，运费行始终保留原始口径。
## 本地传输
本地来源按请求方法和路径匹配，查询和正文不参与路由匹配。响应脚本只负责返回来源原始数据，不替工作台判断业务是否完成。`delayMs` 为本次响应延迟，`disconnect` 表示未返回确定响应便断开连接，`status` 为 HTTP 状态；记录顺序与实际请求一致。来源实例独享响应进度，重新启动恢复第一条。
业务标识区分大小写；金额为最小货币单位的整数，时间为本地来源统一的整数秒。样例中的身份、合同和公司均为合成资料，不是外部系统账号。

## 本地可读资源
`GET /adjustments/V1`、`/adjustments/V2`、`/adjustments/V3`、`/adjustments/V4` 与 `GET /applications/AP1` 至 `AP5` 返回合成业务资料；正常样例中的身份与主领取记录一致，覆盖分次抵扣、申诉、撤回未使用、使用后冲回四种情形。

来源路径可包含具名段，按段匹配。`requireBody` 与 `requireQuery` 可限制业务范围，不符合时返回409且不推进响应序列；`requireAuthentication` 表示该路由要求授权。`GET /counters` 只返回来源处理次数，不参与收件决策。
