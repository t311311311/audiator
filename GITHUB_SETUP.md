# Инструкция по завершению публикации на GitHub

## ✅ Что уже сделано

- [x] Создан репозиторий: https://github.com/t311311311/audiator
- [x] Все файлы закоммичены локально
- [x] Ветка переименована в `main`
- [x] Релиз-ноты готовы: `release-notes.md`
- [x] Установщик готов: `dist\Audiator Setup 1.0.7.exe`

## 📋 Что нужно сделать после перезагрузки

### Шаг 1: Откройте терминал в папке проекта

```
cd C:\Test01\tray-translator
```

### Шаг 2: Загрузите код в GitHub

```bash
set "PATH=C:\Program Files\GitHub CLI;%PATH%"
git push -u origin main
```

### Шаг 3: Создайте релиз

```bash
set "PATH=C:\Program Files\GitHub CLI;%PATH%"
gh release create v1.0.7 "dist\Audiator Setup 1.0.7.exe" --title "Audiator v1.0.7" --notes-file "release-notes.md"
```

### Шаг 4: Проверьте релиз

Откройте в браузере:
```
https://github.com/t311311311/audiator/releases
```

---

## 🔑 Токен GitHub

Токен сохранён в системе (keyring). Если потребуется повторная авторизация:

```bash
gh auth login --with-token
```

---

## 📁 Файлы проекта

| Файл | Назначение |
|------|------------|
| `README.md` | Описание проекта |
| `CHANGELOG.md` | История изменений |
| `.gitignore` | Игнорируемые файлы |
| `release-notes.md` | Примечания к релизу |

---

**Дата создания:** 28 февраля 2026 г.
**Версия:** 1.0.7
