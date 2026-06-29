# Verification Test File

## Markdown Elements
This file tests the rendering of various markdown elements in the workspace docs viewer.

### Headers
#### Header 4
##### Header 5

### Lists
- Unordered item 1
- Unordered item 2
  - Nested unordered item

1. Ordered item 1
2. Ordered item 2

### Code Blocks
Here is some inline code: `const x = 10;`.

And here is a fenced code block:
```python
def hello_world():
    print("Hello, world!")
    return True
```

### GitHub Alerts
> [!NOTE]
> This is a Note alert. It should render with a blue accent.

> [!TIP]
> This is a Tip alert. It should render with a green accent.

> [!IMPORTANT]
> This is an Important alert. It should render with a purple accent.

> [!WARNING]
> This is a Warning alert. It should render with an orange accent.

> [!CAUTION]
> This is a Caution alert. It should render with a red accent.

### Task Lists Checkboxes
- [ ] Unchecked Task
- [x] Checked Task
- [/] In Progress Task

