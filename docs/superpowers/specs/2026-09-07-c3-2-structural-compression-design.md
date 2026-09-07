# C3.2 — Структурное сжатие и чистое понижение макросов

Дата: 2026-09-07

Задача: #373

Принятая база дизайна: `6791fa3d842bb3031869d602601565a9e334fd1f`

## 1. Цель

C3.2 удаляет знание конкретных методик из канонического ядра и заменяет специальную обработку `contract_conformance.cochange` на одну универсальную структурную конструкцию.

После понижения высокоуровневого пакета должно выполняться:

```text
source pack vocabulary
    ↓ pure lowering
canonical policy / facts / constraints
```

Каноническая программа ограничений, сравнение политик и вычислитель не должны знать роли:

```text
current.contract
current.conformance
previous.contract
previous.conformance
acceptance
```

Эти роли допустимы только внутри слоя компиляции и понижения высокоуровневого пакета.

## 2. Текущее состояние и проблема

На базе C3.1 `contract_conformance` уже компилируется в универсальные `document_relations`, но `cochange` остаётся специальным случаем.

Сейчас высокоуровневый компилятор делает следующее:

```text
contract_conformance.cochange = [r1, r2, ..., rN]
    ↓
N × (N - 1) directed cochange_rules
```

Для пяти ролей это даёт двадцать направленных правил.

Затем канонический `constraint-program.mts` пытается восстановить потерянное происхождение:

```text
ordinary cochange_rules
    ↓ reverse recognition
contract-conformance role edges
```

Для этого ядро содержит:

- `ContractConformanceRole`;
- `CONTRACT_CONFORMANCE_DOCUMENT_ROLES`;
- `contractConformanceRolesByPath(...)`;
- `cochangeRoleEdge(...)`;
- `generatedContractConformanceCochange(...)`;
- отдельную идентичность и диагностику сгенерированных рёбер.

Это нарушает инвариант чистого понижения: высокоуровневый смысл сначала уничтожается, затем каноническое ядро пытается его восстановить.

Дополнительная проблема — позиционная идентичность обычных `cochange_rules`:

```text
cochange:<index>
cochange-policy:<index>
/cochange_rules/<index>
```

Она зависит от порядка массива и не выражает семантическую сущность ограничения.

## 3. Выбранное решение

Вводится одна универсальная каноническая конструкция `cochange_groups`:

```json
{
  "cochange_groups": [
    {
      "id": "contract-conformance",
      "members": [
        "contracts/current.json",
        "conformance/current.json",
        "contracts/previous.json",
        "conformance/previous.json",
        "acceptance.json"
      ]
    }
  ]
}
```

Она не зависит от предметной области. Ядро не знает, почему эти пути образуют группу.

### 3.1. Семантика

Для группы `members` определяется:

```text
C = changed_paths ∩ members

PASS ⇔ C = ∅ ∨ C = members
```

То есть:

- не изменился ни один участник — правило выполнено;
- изменились все участники — правило выполнено;
- изменилось любое непустое собственное подмножество — нарушение.

Это ограничение «все вместе или никто».

### 3.2. Область применения

Конструкция пригодна не только для пары контрактов и подтверждений:

```text
schema + generated types
manifest + lockfile
contract + conformance
VERSION + release metadata
API spec + generated client
```

Наличие нескольких независимых применений доказывает, что примитив универсален и не маскирует специальную предметную семантику.

## 4. Чистое понижение `contract_conformance`

`policy-profiles.mts` остаётся единственным слоем, который имеет право знать высокоуровневые роли.

Понижение выполняется так:

```text
contract_conformance.cochange roles
    ↓ resolve role -> canonical repository path
one cochange_group
```

Например:

```text
[current.contract, current.conformance, acceptance]
    ↓
cochange_group {
  id: "contract-conformance",
  members: [<current-contract-path>, <current-conformance-path>, <acceptance-path>]
}
```

После `resolvePolicyProfile()` в канонической политике не остаётся словаря ролей исходного пакета.

Направленные рёбра для этого макроса больше не генерируются.

## 5. Каноническая идентичность

У группы семантическая идентичность:

```text
cochange-group:<id>
```

Ключ выполнения, владелец ограничения и сравнение политик должны опираться на `id`, а не на позицию массива.

Порядок `cochange_groups` не влияет на идентичность.

Порядок `members` также не меняет семантику. Для сравнения участники нормализуются как множество канонических путей репозитория.

## 6. Сравнение политик и строгость

Сама сущность группы является обязательной сущностью:

```text
owner = cochange-group:<id>
relation = required_entity
```

Удаление группы является ослаблением политики.

Изменение `members` в C3.2 трактуется как:

```text
equal_or_incomparable
```

Причина: ни добавление, ни удаление участника не задаёт общего безопасного монотонного порядка. Такое изменение может усиливать одни допустимые переходы и ослаблять другие.

C3.2 не вводит фиктивный порядок строгости ради удобства сравнения.

## 7. Модель выполнения

Предпочтительная каноническая форма во время выполнения:

```text
kind: cochange_group
name: <semantic owner>
members: <canonical path set>
```

Фаза выполнения:

```text
transaction
```

Вычислитель получает только факты изменения путей и список `members`.

Он не получает:

- роли контрактов и подтверждений;
- метаданные исходного макроса;
- метаданные сгенерированных рёбер;
- позиционный индекс как семантическую идентичность.

Вторая система вычисления не создаётся.

## 8. Отношение к существующим `cochange_rules`

Существующие направленные `cochange_rules` имеют другую семантику:

```text
if A changed => at least one path from B changed
```

Аудит принятого `repo-policy.json` подтвердил независимого реального потребителя: сам репозиторий требует изменение `tests/**`, когда затронут `src/**`.

Следовательно, направленная возможность не является устаревшей совместимостью и сохраняется как отдельная универсальная семантика.

C3.2 фиксирует следующие границы:

1. `contract_conformance` больше не генерирует направленные `cochange_rules`.
2. Для высокоуровневого `cochange` создаётся ровно одна `cochange_group`.
3. Обратное распознавание сгенерированных рёбер полностью удаляется.
4. Самостоятельные направленные `cochange_rules` продолжают работать по своей исходной универсальной семантике.
5. Между `cochange_rules` и `cochange_groups` не вводится псевдоним, адаптер или автоматическая взаимная конверсия.

Таким образом две конструкции остаются только потому, что выражают разные ограничения, а не ради поддержки старого способа представления одного и того же смысла.

## 9. Каноническое ядро после перехода

Из `constraint-program.mts` должны исчезнуть все элементы, завязанные на конкретный пакет:

```text
ContractConformanceRole
CONTRACT_CONFORMANCE_DOCUMENT_ROLES
contractConformanceRolesByPath
cochangeRoleEdge
generatedContractConformanceCochange
current.contract
current.conformance
previous.contract
previous.conformance
acceptance
```

Ядро должно видеть только универсальные понятия:

```text
cochange_groups
id
members
changed_paths
```

## 10. Публичная схема

`cochange_groups` является публичной канонической частью политики, а не скрытым промежуточным представлением.

Минимальная структурная схема:

```json
{
  "cochange_groups": [
    {
      "id": "string",
      "members": ["repository/path", "repository/path"]
    }
  ]
}
```

Структурная проверка должна требовать:

- непустой `id`;
- минимум два различных участника;
- канонические пути репозитория;
- отсутствие повторов внутри `members`;
- уникальный `id` среди групп.

Высокоуровневый компилятор обязан генерировать валидную каноническую форму и не должен рассчитывать на исправление ошибочного результата во время выполнения.

## 11. Диагностика

При нарушении выводится семантический идентификатор группы и полный набор изменённых и пропущенных участников, например:

```text
cochange group "contract-conformance" requires all members to change together
changed: [contracts/current.json]
missing: [conformance/current.json, acceptance.json]
```

Диагностика не должна упоминать:

- сгенерированные рёбра;
- восстановление ролей;
- индекс массива;
- внутреннюю историю понижения.

## 12. Фальсификатор и контракт TDD

Первый красный тест должен доказать архитектуру, а не только одно поведение.

Для пяти ролей:

```text
high-level roles = 5
canonical cochange groups = 1
canonical generated directed edges = 0
```

Матрица поведения:

```text
0 changed        -> PASS
1 changed        -> FAIL
2..N-1 changed   -> FAIL
N changed        -> PASS
```

Проверки идентичности:

```text
reorder unrelated policy arrays -> same group identity
reorder cochange_groups         -> same group identity
reorder members                 -> same semantic shape
```

Проверки словаря ядра:

```text
constraint-program.mts contains none of:
  current.contract
  current.conformance
  previous.contract
  previous.conformance
  acceptance
  CONTRACT_CONFORMANCE_DOCUMENT_ROLES
  generatedContractConformanceCochange
```

Отдельный регрессионный тест сохраняет независимую направленную семантику:

```text
src/** changed, tests/** unchanged -> directed cochange_rules FAIL
src/** changed, tests/** changed   -> directed cochange_rules PASS
```

## 13. Метрики сжатия

C3.2 должна измеримо уменьшить архитектурную амплификацию.

Критерии:

```text
contract-conformance role vocabulary in canonical core = 0
generated-edge recognition helpers = 0
generated cochange constraints for N roles = 1
positional identity for macro-generated cochange = 0
high-level pack semantic edit-sites in canonical core = 0
```

Новый примитив допустим только если итоговое число архитектурных понятий и независимых мест семантической правки уменьшается относительно принятого состояния C3.1.

Тесты, сценарии и наблюдаемость уменьшаться не обязаны.

## 14. Документация

Так как `cochange_groups` становится публичной канонической частью политики, тот же PR обязан синхронизировать:

- описание схемы;
- README и архитектурные документы, где перечислена каноническая поверхность политики;
- примеры, если там показывается совместное изменение файлов;
- метрики Compression 3, если они учитывают структурные примитивы.

Русский остаётся основным языком пользовательской архитектурной документации; идентификаторы и машинный синтаксис остаются техническими.

## 15. Без совместимости и запрещённые результаты

Запрещено:

- сохранять обратное распознавание под устаревшим именем;
- поддерживать одновременно N²-рёбра макроса и каноническую группу;
- добавлять знание `contract_conformance` в вычислитель;
- вводить второй вычислитель;
- добавлять язык произвольных предикатов или выражений;
- делать `cochange_group` специальным примитивом контрактов;
- сохранять позиционную идентичность для группы, созданной макросом;
- ослаблять собственную политику repo-guard ради прохождения C3.2.

## 16. Предлагаемая граница реализации

Ожидаемая зона изменений:

```text
src/policy-profiles.mts
src/checks/constraint-program.mts
src/checks/rules/constraints.mts
schemas/**
tests/**
dist/**
README.md / docs / examples — только если затронута соответствующая public surface
scripts/compression-metrics.mjs — только для измеримого C3.2 acceptance
```

Не предполагаются изменения:

```text
package.json version
release/tag
GitHub Pages
CI optimization
external consumer validation
```

Эти работы принадлежат более поздним фазам C3.

## 17. Критерии принятия

C3.2 считается принятой только если одновременно доказано:

1. `contract_conformance` компилируется полностью до нейтральной канонической политики;
2. для высокоуровневого совместного изменения создаётся одна `cochange_group`, а не N² рёбер;
3. каноническое ядро не содержит словаря ролей контрактов и подтверждений;
4. обратное распознавание полностью удалено;
5. идентичность группы семантическая и не зависит от позиции;
6. ошибочная структура закрывается отказом на границе схемы или компилятора;
7. семантика «все вместе или никто» доказана тестами;
8. самостоятельная направленная семантика `cochange_rules` сохранена и доказана отдельным тестом;
9. сравнение политик не придумывает ложный монотонный порядок для изменения `members`;
10. сгенерированный `dist` актуален;
11. собственный repo-guard, `validate` и `smoke-pack` зелёные;
12. документация синхронизирована;
13. ни одного псевдонима или адаптера старого представления макроса не осталось.
