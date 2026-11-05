"""기상특보 통보문(getWthrWrnMsg) 본문에서 평수구역·연안바다 제외/해제/발표를 읽어 전국 해역별 특보 상태를 만든다.

해역 코드 자료(wrn_now_data)에는 평수구역·연안바다가 따로 나오지 않아, 통보문 해당구역 칸의 괄호 표기를 읽는다.
(2026.1~11 통보문 2,579건 분석: 평수구역·연안바다는 풍랑주의보에서만, 아래 형식으로만 나옴)
  - 발표/연장 때 제외 : 전남중부서해앞바다(먼평수구역, 앞평수구역 제외)
  - 하위 구역만 해제 : 풍랑주의보 해제 : 서해남부남쪽안쪽먼바다( 조도부근평수구역 )
  - 하위 구역만 발표 : 풍랑주의보 발표 : 전남북부서해앞바다( 평수구역 )
구역 구분자는 쉼표 또는 점(.)
"""
import re

from .wrn_zones import PARENTS, SUBS

NOTICE_STNS = (108, 156, 184)  # 본청, 광주지방기상청, 제주지방기상청 (진도 주변 해역 발표 관서)


def _norm(s):
    return re.sub(r"[\s·.ㆍ]", "", s or "")


PARENT_BY_NAME = {_norm(name): pid for pid, name in PARENTS.items()}
SUB_BY_PARENT = {}
SUB_BY_NAME = {}
SUB_PARENT = {}
ZONE_NAME = dict(PARENTS)
for sid, pid, name in SUBS:
    SUB_PARENT[sid] = pid
    if pid:
        SUB_BY_PARENT.setdefault(pid, {})[_norm(name)] = sid
        ZONE_NAME[sid] = f"{PARENTS[pid]} {name}"
    else:
        SUB_BY_NAME[_norm(name)] = sid
        ZONE_NAME[sid] = name
ALL_ZONES = list(PARENTS) + [sid for sid, _, _ in SUBS]

ITEM_RE = re.compile(r"\((\d+)\)\s*([^:\n]*?)\s*(발표|해제|변경|연장|대치)\s*:")
TIME_RE = re.compile(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2})시\s*(\d{1,2})분")
PAREN_RE = re.compile(r"([가-힣0-9·]+)[ \t]*\(([^()]*)\)")
SPLIT_RE = re.compile(r"[,.\n/]")


def _find_sub(pid, sub):
    subs = SUB_BY_PARENT.get(pid, {}) if pid else SUB_BY_NAME
    if sub in subs:
        return subs[sub]
    hits = [sid for name, sid in subs.items() if len(sub) >= 4 and (name.startswith(sub) or sub.startswith(name))]
    return hits[0] if len(hits) == 1 else None


def _is_sub_paren(inner):
    return "평수" in inner or "연안" in inner


def _split_items(text):
    """'(1) 풍랑주의보 해제 : ...' 단위로 자른다 → {번호: (특보명, 명령, 본문)}"""
    text = text or ""
    marks = list(ITEM_RE.finditer(text))
    out = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out[m.group(1)] = (_norm(m.group(2)), m.group(3), text[m.end():end])
    return out


def _times(t3):
    out = {}
    for num, (_, _, body) in _split_items(t3).items():
        m = TIME_RE.search(body)
        if m:
            y, mo, d, h, mi = m.groups()
            out[num] = f"{y}{int(mo):02d}{int(d):02d}{int(h):02d}{int(mi):02d}"
    return out


def parse_notice(item):
    """통보문 1건 → (events, unparsed)
    event: {zone_id, parent_id, wrn, level, action, tmEf, tmFc}
      action: exclude(발표 때 제외) | release(하위 구역만 해제) | include(하위 구역만 발표) | base_release(상위 해역 해제)"""
    events, unparsed = [], []
    times = _times(item.get("t3"))
    tm_fc = str(item.get("tmFc", ""))
    for num, (wname, cmd, body) in _split_items(item.get("t2")).items():
        wrn = wname.replace("주의보", "").replace("경보", "")
        base = {"wrn": wrn, "level": wname, "tmEf": times.get(num, tm_fc), "tmFc": tm_fc}
        for m in PAREN_RE.finditer(body):
            if not _is_sub_paren(m.group(2)):
                continue  # 서해남부앞바다(전남북부서해앞바다, ...) 처럼 하위 해역을 나열한 괄호
            pid = PARENT_BY_NAME.get(_norm(m.group(1)))
            exclude = "제외" in m.group(2)
            for part in SPLIT_RE.split(m.group(2).replace("제외", "")):
                sub = _norm(part)
                if not sub:
                    continue
                sid = _find_sub(pid, sub)
                if not sid:
                    unparsed.append(m.group(0).strip())
                    continue
                action = "release" if cmd == "해제" else ("exclude" if exclude else "include")
                events.append({**base, "zone_id": sid, "parent_id": pid, "action": action})
        if cmd == "해제":
            # 하위 구역 괄호를 뺀 나머지에 적힌 상위 해역 = 상위 해역 해제
            rest = PAREN_RE.sub(lambda m: " " if _is_sub_paren(m.group(2)) else f"{m.group(1)},{m.group(2)}", body)
            for tok in re.split(r"[,.\n/()]", rest):
                bid = PARENT_BY_NAME.get(_norm(tok))
                if bid:
                    events.append({**base, "zone_id": bid, "parent_id": None, "action": "base_release"})
    return events, "; ".join(dict.fromkeys(unparsed))


def build_status(base, events, now_digits):
    """base: {코드: [특보...]}(wrn_now_data), events: 통보문에서 읽은 기록(오래된 순)
    → 전국 {구역코드: {"warnings": [...], "note": str}}"""
    status = {pid: {"warnings": base.get(pid, []), "note": ""} for pid in PARENTS}
    for sid, pid, _ in SUBS:
        if sid in base or not pid:
            status[sid] = {"warnings": base.get(sid, []), "note": ""}
            continue
        ws, notes = [], []
        for w in base.get(pid, []):
            off = None
            for e in events:
                if e.get("zone_id") != sid or e.get("wrn") != w.get("wrn"):
                    continue
                if e["tmFc"] < str(w.get("tmFc", "")):
                    continue  # 상위 해역 특보가 다시 발표되기 전의 기록
                if e["action"] == "include":
                    off = None
                elif e["action"] == "exclude" or e["tmEf"] <= now_digits:
                    off = e
            if off:
                notes.append(e_text(off))
            else:
                ws.append(w)
        status[sid] = {"warnings": ws, "note": " / ".join(notes)}
    return status


def e_text(e):
    t = e.get("tmEf", "")
    when = f"{int(t[6:8])}일 {t[8:10]}:{t[10:12]}" if len(t) >= 12 else ""
    if e["action"] == "exclude":
        return f"{e['level']} 제외"
    return f"{e['level']} 해제" + (f" ({when})" if when else "")
