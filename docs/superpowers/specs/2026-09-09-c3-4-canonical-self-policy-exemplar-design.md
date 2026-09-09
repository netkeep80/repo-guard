# C3.4 — каноническая self-policy как живой пример

Дата: 2026-09-09

Родительская задача: #375

Дорожная карта: #370

Зависит от принятой C3.3: #374

Принятая база перед проектированием:

```text
main = abd89e9c0ec5d9244756894f970b04db2aa26501
```

Каноническая база измерений C3.0:

```text
92432809fcddc290080beb51ba151e13a5761869
```

## 1. Цель

C3.4 должна сделать сам репозиторий `repo-guard` самым маленьким честным производственным примером архитектуры, принятой после C3.3.

Собственная политика должна описывать только реальные инварианты этого репозитория. Она не должна быть каталогом всех возможностей продукта и не должна сохранять исторические конструкции только ради демонстрации.

Главный принцип:

```text
проще > шире
универсальнее > специфичнее
удалить > продублировать > спрятать в макрос
реальное исполнение > декларативная имитация исполнения
```

C3.4 не разрешает вводить новый runtime, профиль, язык интеграции, второй язык политики или специальный обход для собственного репозитория.

## 2. Принятая архитектурная граница

После C3.3 канонический семантический путь имеет вид:

```text
Git / GitHub / filesystem
          ↓
finite typed facts
          ↓
FactRef
          ↓
Constraint Program
          ↓
primitive_relation
          ↓
relation kernel
          ↓
AnalysisReport
```

Жёсткие инварианты C3.4:

```text
runtime constraint kinds = 1
final runtime kind = primitive_relation
FactRef models = 1
FactRef sources = 4
relation descriptors = 10
primitive descriptor registries = 1
second evaluator = NONE
arbitrary expression language = NONE
compatibility aliases = NONE
repo-specific semantic bypass = NONE
```

C3.4 не должна увеличивать эти количества. Исключение допустимо только после отдельного потребительского фальсификатора, доказывающего универсальный пробел. Сейчас такого пробела не обнаружено.

## 3. Проблема текущей собственной политики

Текущий `repo-policy.json` корректен, но всё ещё похож на широкий показ возможностей продукта, а не на минимальную исполняемую формулировку реальных инвариантов `repo-guard`.

Главное дублирование:

```text
surfaces
new_file_classes
change_profiles
```

`surfaces` и `new_file_classes` в основном повторяют одну и ту же классификацию путей, а пять `change_profiles` повторно задают разрешённые комбинации поверх этой классификации.

При этом каждый реальный PR уже объявляет собственную исполняемую границу перехода через `ChangeIntent`:

```text
change_type
scope
budgets
must_touch
must_not_touch
expected_effects
```

Готовый PR проверяется самим публичным действием `repo-guard`:

```text
uses: ./
mode: check-pr
enforcement: blocking
```

Следовательно, собственной политике не нужна большая внутренняя таксономия только ради классификации методологии изменения.

## 4. Выбранный вариант — минимальный живой пример

Рассмотрены три подхода.

### A. Минимальный живой пример — выбран

В `repo-policy.json` остаются только реальные инварианты репозитория. Возможности продукта, которые самому `repo-guard` не нужны, проверяются специализированными тестами и примерами, но не навязываются собственной политике.

### B. Сжатая таксономия — отклонён

Сохранить `surfaces` и `change_profiles`, сократив только количество категорий.

Подход отклонён: политика всё равно будет хранить методологическую классификацию, уже задаваемую `ChangeIntent` каждого PR.

### C. Широкий показ возможностей — отклонён

Оставить нынешнюю форму политики и лишь добавить больше проверок самоприменения.

Подход отклонён: он сохраняет сложность специально ради демонстрации и противоречит Architecture Compression 3.0.

## 5. Целевая собственная политика

Каноническая политика самого `repo-guard` должна содержать только следующие категории, если `RED` не докажет необходимость ещё одного реального инварианта:

```text
policy identity
blocking enforcement
trusted governance paths
forbidden paths
operational paths
global diff budgets
real compression / size bounds
real content rules
real source -> test cochange
stable public metadata / document relations
```

Под идентичностью политики здесь понимаются существующие поля формата и вида репозитория, а не новый механизм идентификации.

Из собственного `repo-policy.json` ожидается удаление:

```text
surfaces
new_file_classes
change_profiles
```

Это только сжатие собственной политики. Публичные возможности продукта не удаляются из схемы или runtime только потому, что сам `repo-guard` больше не использует их.

Запрещено создавать встроенный профиль `repo-guard`, `tooling`, `self-host` или аналогичный профиль, который просто перенесёт ту же сложность из JSON в TypeScript.

## 6. Устойчивые структурные инварианты выражаются существующими отношениями документов

C3.4 должна показать в собственной политике каноническую модель фактов и отношений там, где инвариант действительно структурный.

Начальные кандидаты используют только существующие универсальные отношения:

```text
package.json:/main
  =
package.json:/bin/repo-guard

package.json:/main
  =
"dist/repo-guard.mjs"

action.yml:/inputs/mode/default
  =
"check-pr"

action.yml:/inputs/enforcement/default
  =
"blocking"
```

Окончательный набор должен оставаться минимальным. Каждое отношение обязано выражать реальную публичную или исполняемую границу, а не искусственный пример возможности.

Достаточны уже существующие примитивы:

```text
scalar_equal
scalar_equals_literal
```

Новый примитив интеграции или специальный селектор рабочего процесса запрещён.

## 7. Исполнение рабочего процесса является доказательством, а не текстовой семантикой политики

C3.4 сохраняет решение C3.3: конфигурация GitHub Actions не становится вторым языком политики.

Не следует добавлять правила, которые разбирают массивы шагов, строки команд или текст рабочего процесса только ради доказательства CI-связности.

Неправильное направление:

```text
workflow YAML text -> special policy evaluator
```

Правильное доказательство:

```text
real CI execution
  -> check:dist
  -> compression metrics
  -> repo-policy validation
  -> doctor
  -> discovered tests
  -> public Action check-pr
  -> smoke packaged artifact
```

Сгенерированный `dist` аналогично доказывается настоящей командой `npm run check:dist`. Слабое правило вида `src changed -> dist changed` не является эквивалентом и не должно заменять проверку свежести сборки.

## 8. Машинно наблюдаемая топология самоприменения

C3.4 должна сделать полный путь самоприменения механически проверяемым по уже существующим авторитетным артефактам, не создавая вручную поддерживаемый манифест топологии.

Требуемая цепь:

```text
ChangeIntent
    ↓
trusted BASE repo-policy
    ↓
trusted GovernanceGrant for governance mutation
    ↓
protected PR
    ↓
repo-guard public Action (uses: ./, check-pr, blocking)
    ↓
validate + smoke-pack required checks
    ↓
accepted main
```

Репозиторный фальсификатор должен выводить доказательства непосредственно из существующих файлов:

```text
repo-policy.json
.github/PULL_REQUEST_TEMPLATE.md
.github/ISSUE_TEMPLATE/change-intent.yml
.github/workflows/ci.yml
action.yml
package.json
```

Настройка защиты ветки и набор обязательных проверок не копируются в новый файл политики. Их точное состояние проверяется как внешний GitHub acceptance evidence при приёмке PR, а не превращается в семантику runtime.

## 9. Граница управляющих файлов

Доверенная управляющая область должна включать файлы, которые действительно определяют политику, валидацию, действие, CI, сборку и выпуск.

Текущий набор следует проверить на обоснованное усиление, включая реальные управляющие файлы вроде:

```text
package.json
package-lock.json
tsconfig.json
scripts/build.mjs
scripts/check-dist.mjs
scripts/verify-release-ref.mjs
```

В управляющую область включаются только файлы с реальными полномочиями. Обычный исходный код не становится governance только потому, что он важен.

Расширение управляющих путей является усилением политики и всё равно обязано пройти обычную доверенную границу.

## 10. Универсальное уточнение strictness перед переписыванием политики

Текущий `compareConstraintPrograms()` отдельно сравнивает известные strictness-ограничения, а затем строит `unknownProjection()` для оставшихся частей политики, не представленных в `Constraint Program` strictness.

Сейчас любое изменение этой остаточной проекции сворачивается в один несопоставимый указатель:

```text
/
```

Из-за этого узкое сжатие собственной политики может потребовать недопустимо широкую санкцию:

```text
allow_policy_relaxation:
  - /
```

C3.4 не должна использовать такой обход.

Перед удалением секций собственной политики нужно сделать одно универсальное улучшение:

```text
unknownProjection сравнивается независимо по top-level ключам
```

То есть изменение независимых остаточных секций должно выдавать отдельные указатели, например:

```text
/surfaces
/new_file_classes
/change_profiles
```

Алгоритм не должен содержать имена этих полей. Он должен универсально работать с любыми top-level ключами остаточной проекции.

Вложенный объект внутри одного неизвестного top-level ключа остаётся одной единицей сравнения. C3.4 не вводит рекурсивный произвольный язык сравнения JSON и не усложняет strictness больше, чем требуется для узкой доверенной санкции.

Новый runtime kind или relation descriptor для этого не нужен.

## 11. Правдивость self-hosting coverage

Текущая документация утверждает, что `tests/test-self-hosting.mjs` выводит список команд, семейств и профилей и сопоставляет его с собственной политикой, CI и исключениями. Фактический тест сейчас в основном проверяет `doctor` и свойства окружения.

C3.4 должна устранить это расхождение между документацией и исполняемой проверкой.

Предпочтительное состояние:

```text
derived capability inventory from code / registries
+
actual self-host evidence from repository artifacts
+
self-hosting-coverage.json only for honest exceptions
```

Не требуется перегружать существующий doctor-тест другой ответственностью. Допустим отдельный сфокусированный self-exemplar ratchet, если так границы тестов будут проще.

`docs/self-hosting-coverage.json` остаётся только списком честных исключений. Полную матрицу возможностей вручную дублировать нельзя.

Если возможность продукта намеренно не применяется к самому `repo-guard`, её специализированный тест доказывает capability, а файл исключений объясняет, почему dogfooding был бы искусственным.

## 12. Шаблоны и документация

C3.4 должна синхронизировать пользовательские примеры с принятой живой архитектурой.

Известный drift, который необходимо удалить:

```text
templates/repo-policy.min.json
  policy_format_version 0.1.0 -> current canonical version

templates/example-workflow.yml
  stale Action dependency versions -> current supported example

README.md
  remove already-deleted historical product concepts
  use canonical self-policy as the primary real example where useful
```

Шаблоны остаются минимальными примерами для потребителя. Они не обязаны слепо копировать все ограничения собственного репозитория.

## 13. Разбиение реализации

C3.4 реализуется двумя отдельно принимаемыми срезами.

### C3.4a — универсальная гранулярность strictness

Цель:

```text
root-wide residual incomparable pointer
  -> independent top-level residual pointers
```

Свойства:

```text
generic algorithm only
no repo-policy rewrite
no new primitive
no new FactRef source
no relation descriptor growth
no repository-specific field names in comparison logic
```

Первый `RED` обязан показать, что принятая база выдаёт широкий корневой указатель при независимых изменениях остаточных top-level секций и что целевое поведение требует узких указателей по ключам.

### C3.4b — канонический живой пример

Только после принятия C3.4a:

```text
compress repo-policy.json
add only real existing document relations
strengthen governance paths where justified
repair self-hosting evidence ratchet
sync templates / docs
measure final self-policy complexity
```

После merge не остаётся compatibility-слоя между старой и новой собственной политикой.

## 14. TDD и приёмка

Каждый implementation slice выполняется через test-only `RED` перед production change.

Приёмка C3.4a:

```text
test-only RED first
focused GREEN
full discovered suite GREEN
dist fresh
self-policy GREEN
compression metrics GREEN
ready-state validate + smoke-pack + Run PR policy check GREEN
exact-head merge
post-merge validate + smoke-pack GREEN
```

`RED` C3.4b должен доказать минимум:

```text
current self-policy still contains surfaces/new_file_classes/change_profiles
current self-policy size/complexity is the accepted starting point
canonical self-policy does not yet contain selected real document relations
self-hosting documentation claim is not yet mechanically proven
consumer templates contain known stale values
```

Финальная приёмка C3.4b:

```text
self-policy uses only real current repository invariants
surfaces = absent from self-policy
new_file_classes = absent from self-policy
change_profiles = absent from self-policy
selected document_relations = present and evaluated through canonical relation runtime
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
new engine concepts = 0
public Action self-check exercised in ready PR CI
trusted governance path remains fail-closed
check:dist is explicit executable evidence
smoke-pack proves packaged artifact
self-hosting coverage claims match executable tests
README/templates/examples synchronized
policy complexity materially smaller/easier than current and C3.0 baseline
ready-state validate + smoke-pack + Run PR policy check GREEN
exact-head merge
post-merge validate + smoke-pack GREEN
```

## 15. Измерение сжатия

Минимальный отчёт до и после должен включать:

```text
repo-policy bytes
repo-policy top-level concepts
surfaces count
new-file-class count
change-profile count
size-rule count
content-rule count
cochange-rule/group count
document-relation rule count
governance path count
runtime constraint kinds
FactRef models/sources
relation descriptor count
self-hosting exception count
```

Успех определяется не только количеством байтов. Главный результат — меньше независимых понятий, которые нужно понять для ответа на вопрос «как `repo-guard` управляет самим собой?».

## 16. Явно запрещённые направления

```text
NO new runtime kind
NO new FactRef source
NO new relation descriptor without independent consumer RED
NO integration/workflow DSL
NO repo-guard-specific built-in profile
NO capability showcase inside self-policy
NO manually duplicated self-host topology manifest
NO legacy syntax compatibility
NO broad allow_policy_relaxation: /
NO C3.5/C3.6 work folded into C3.4
```

## 17. Финальный архитектурный критерий

Желаемое состояние:

```text
repo-guard's own repository policy
    =
small ordinary consumer policy
+
a few real generic relations
+
trusted governance boundary
+
real CI execution evidence
```

Новый потребитель должен понимать архитектуру, читая собственную политику `repo-guard`, без предварительного изучения специальной метаполитики `repo-guard`.

Именно это C3.4 считает каноническим живым примером.
