from homebuilder_worker.rules import Rule, compile_rule, compile_rules, suggest


def rules(*specs: tuple[str, int | None, int | None, int | None]):
    return compile_rules([Rule(i, *spec) for i, spec in enumerate(specs, start=1)])


def test_whole_word_phrase_matching() -> None:
    compiled = rules(("garage door", None, 8, None))
    assert suggest(compiled, "How to Install a GARAGE DOOR spring").area_type_ids == {8}
    assert suggest(compiled, "garage-door insulation").area_type_ids == {8}
    assert suggest(compiled, "garage   door").area_type_ids == {8}
    assert not suggest(compiled, "garagedoor tips")
    assert not suggest(compiled, "my garage, front door")


def test_does_not_match_inside_words() -> None:
    compiled = rules(("tile", 1, None, None))
    assert suggest(compiled, "Tile backsplash").tag_ids == {1}
    assert not suggest(compiled, "Tiled roof versatile")


def test_collects_all_targets_from_all_matches() -> None:
    compiled = rules(
        ("panel", None, None, 5),
        ("electrical", 2, 16, None),
        ("upgrade", 3, None, None),
    )
    found = suggest(compiled, "Electrical panel upgrade to 200A")
    assert found.tag_ids == {2, 3}
    assert found.area_type_ids == {16}
    assert found.item_ids == {5}


def test_regex_characters_in_phrases_are_literal() -> None:
    compiled = rules(("a.c (unit)", 1, None, None))
    assert suggest(compiled, "Cleaning an A.C (unit) coil").tag_ids == {1}
    assert not suggest(compiled, "abc unit")


def test_empty_phrases_and_titles() -> None:
    assert compile_rule(Rule(1, " !! ", 1, None, None)) is None
    assert not suggest(rules(("roof", 1, None, None)), None)
    assert not suggest(rules(("roof", 1, None, None)), "")
