/**
 * 从好友表一行拼出「我」的资料。没有这一行时只保留 userId。
 */

function asText(value) {
  if (value == null || value === '') return '';
  return String(value).trim();
}

export function buildSelfProfile(userId, row) {
  const displayName = asText(row?.displayName);
  const nickName = asText(row?.nickName);
  const friendNickname = asText(row?.friendNickname ?? row?.friendNickName);
  const accountId = asText(row?.accountId);
  const resolvedName = displayName || nickName || friendNickname;
  let id = userId;
  if (id != null && id !== '') {
    const n = Number(id);
    id = Number.isFinite(n) ? n : id;
  } else {
    id = null;
  }
  return {
    userId: id,
    displayName,
    nickName,
    friendNickname,
    accountId,
    resolvedName,
  };
}

/** 界面展示用的标签-值对，空字段不出现。 */
export function selfProfileLines(profile) {
  const lines = [];
  if (profile.resolvedName) lines.push(['我', profile.resolvedName]);
  lines.push(['用户 ID', profile.userId == null ? '未知' : String(profile.userId)]);
  if (profile.displayName) lines.push(['显示名', profile.displayName]);
  if (profile.nickName && profile.nickName !== profile.displayName) {
    lines.push(['昵称', profile.nickName]);
  }
  if (profile.friendNickname) lines.push(['备注名', profile.friendNickname]);
  if (profile.accountId) lines.push(['账号 ID', profile.accountId]);
  if (!profile.resolvedName) {
    lines.push(['资料', '好友表里没有自己的名字，仅有用户 ID']);
  }
  return lines;
}
