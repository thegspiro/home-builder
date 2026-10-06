"""Keyword rules: case-insensitive whole-word phrase matches on video titles."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Rule:
    id: int
    phrase: str
    tag_id: int | None
    area_type_id: int | None
    item_id: int | None


@dataclass
class Suggestions:
    tag_ids: set[int] = field(default_factory=set)
    area_type_ids: set[int] = field(default_factory=set)
    item_ids: set[int] = field(default_factory=set)

    def __bool__(self) -> bool:
        return bool(self.tag_ids or self.area_type_ids or self.item_ids)


@dataclass(frozen=True)
class CompiledRule:
    rule: Rule
    pattern: re.Pattern[str]


def compile_rule(rule: Rule) -> CompiledRule | None:
    """'Garage door' matches 'garage  door' and 'Garage-Door?' but not 'garagedoor'."""
    words = re.findall(r"[a-z0-9]+", rule.phrase.lower())
    if not words:
        return None
    body = r"[^a-z0-9]+".join(re.escape(w) for w in words)
    return CompiledRule(rule, re.compile(rf"(?<![a-z0-9]){body}(?![a-z0-9])"))


def compile_rules(rules: list[Rule]) -> list[CompiledRule]:
    return [c for c in (compile_rule(r) for r in rules) if c is not None]


def suggest(rules: list[CompiledRule], text: str | None) -> Suggestions:
    found = Suggestions()
    if not text:
        return found
    haystack = text.lower()
    for compiled in rules:
        if compiled.pattern.search(haystack):
            rule = compiled.rule
            if rule.tag_id is not None:
                found.tag_ids.add(rule.tag_id)
            if rule.area_type_id is not None:
                found.area_type_ids.add(rule.area_type_id)
            if rule.item_id is not None:
                found.item_ids.add(rule.item_id)
    return found


def load_rules(conn: Any) -> list[CompiledRule]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, phrase, tag_id, area_type_id, item_id FROM keyword_rules "
            "WHERE enabled = TRUE ORDER BY id"
        )
        rows = cur.fetchall()
    return compile_rules(
        [Rule(r["id"], r["phrase"], r["tag_id"], r["area_type_id"], r["item_id"]) for r in rows]
    )
