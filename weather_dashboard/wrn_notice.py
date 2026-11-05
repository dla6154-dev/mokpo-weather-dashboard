"""기상특보 통보문(getWthrWrnMsg) 본문에서 평수구역·연안바다 제외/해제를 읽어 구역별 특보 상태를 만든다.

해역 코드 자료(wrn_now_data)에는 평수구역이 따로 나오지 않아, 통보문 글의 두 가지 표기를 읽는다.
  - 발표 때 제외 : 전남중부서해앞바다(먼평수구역, 앞평수구역 제외)
  - 발표 뒤 해제 : 풍랑주의보 해제 : 서해남부남쪽안쪽먼바다( 조도부근평수구역 )
"""
import re

# 기상상황부 표와 같은 구역 (상위 해역 코드, 하위 구역 코드)
ZONES = [
    ("S1231300", "전남북부서해앞바다", [("S2210300", "평수구역")]),
    ("S1231400", "전남중부서해앞바다", [("S2211300", "먼평수구역"), ("S2211400", "앞평수구역")]),
    ("S1231500", "전남남부서해앞바다", [("S2210500", "평수구역")]),
    ("S1232110", "서해남부북쪽안쪽먼바다", []),
    ("S1232210", "서해남부남쪽안쪽먼바다", [("S2211200", "조도부근평수구역")]),
    ("S1321100", "전남서부남해앞바다", [("S2310700", "평수구역")]),
    ("S1322100", "남해서부서쪽먼바다", [("S2330100", "추자도연안바다")]),
]
NOTICE_STNS = (156, 184)  # 광주지방기상청, 제주지방기상청

def _norm(s):
    return re.sub(r"[\s·.ㆍ]", "", s or "")

PARENT_BY_NAME = {_norm(name): pid for pid, name, _ in ZONES}
SUB_BY_PARENT = {pid: {_norm(sub): sid for sid, sub in subs} for pid, _, subs in ZONES}
ZONE_NAME = {}
SUB_PARENT = {}
for pid, name, subs in ZONES:
    ZONE_NAME[pid] = name
    for sid, sub in subs:
        ZONE_NAME[sid] = f"{name} {sub}"
        SUB_PARENT[sid] = pid

ITEM_RE = re.compile(r"\((\d+)\)\s*([^:\n]*?)\s*(발표|해제|변경|연장)\s*:")
TIME_RE = re.compile(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2})시\s*(\d{1,2})분")
PAREN_RE = re.compile(r"([가-힣0-9·.]+)[ \t]*\(([^()]*)\)")


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
    """통보문 1건 → (events, unparsed). event: {zone_id, parent_id, wrn, action(exclude|release|include), tmEf}"""
    events, unparsed = [], []
    times = _times(item.get("t3"))
    tm_fc = str(item.get("tmFc", ""))
    for num, (wname, cmd, body) in _split_items(item.get("t2")).items():
        wrn = wname.replace("주의보", "").replace("경보", "")
        for m in PAREN_RE.finditer(body):
            parent_txt, inner = _norm(m.group(1)), m.group(2)
            if "평수" not in inner and "연안" not in inner:
                continue  # 서해남부앞바다(전남북부서해앞바다, ...) 처럼 하위 해역을 나열한 괄호
            pid = PARENT_BY_NAME.get(parent_txt)
            exclude = "제외" in inner
            for part in inner.replace("제외", "").split(","):
                sub = _norm(part)
                if not sub:
                    continue
                sid = SUB_BY_PARENT.get(pid, {}).get(sub) if pid else None
                if not sid:
                    unparsed.append(m.group(0).strip())
                    continue
                action = "release" if cmd == "해제" else ("exclude" if exclude else "include")
                events.append({"zone_id": sid, "parent_id": pid, "wrn": wrn, "action": action,
                               "tmEf": times.get(num, tm_fc), "tmFc": tm_fc, "level": wname})
    return events, "; ".join(dict.fromkeys(unparsed))


def build_status(base, events, now_digits):
    """base: {상위코드: [특보...]}(wrn_now_data), events: 통보문에서 읽은 기록(오래된 순)
    → {구역코드: {"warnings": [...], "note": str}}"""
    status = {}
    for pid, _, subs in ZONES:
        status[pid] = {"warnings": base.get(pid, []), "note": ""}
        for sid, _ in subs:
            ws, notes = [], []
            for w in base.get(sid) or base.get(pid, []):
                if sid in base:
                    ws.append(w)
                    continue
                off = None
                for e in events:
                    if e["zone_id"] != sid or e["wrn"] != w.get("wrn"):
                        continue
                    if e["tmFc"] < str(w.get("tmFc", "")):
                        continue  # 상위 특보가 다시 발표되기 전의 기록
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
    return f"{e['level']} {'제외' if e['action'] == 'exclude' else '해제'}" + (f" ({when})" if when and e["action"] == "release" else "")
