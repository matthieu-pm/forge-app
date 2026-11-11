//! Minimal owned DOM for html5ever's public TreeSink interface. Nodes are also
//! owned by a flat arena so deeply nested untrusted input has an iterative drop.
use html5ever::{
    Attribute, QualName, parse_document,
    tendril::{StrTendril, TendrilSink},
    tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink},
};
use std::{
    borrow::Cow,
    cell::RefCell,
    rc::{Rc, Weak},
};
pub(super) type Handle = Rc<Node>;
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    Document,
    Element,
    Text,
    Comment,
}
pub(super) struct Node {
    pub kind: Kind,
    pub name: Option<QualName>,
    pub text: RefCell<String>,
    pub attrs: RefCell<Vec<Attribute>>,
    pub children: RefCell<Vec<Handle>>,
    pub parent: RefCell<Weak<Node>>,
    template: Option<Handle>,
    integration: bool,
}
impl Node {
    fn new(
        kind: Kind,
        name: Option<QualName>,
        text: String,
        attrs: Vec<Attribute>,
        template: Option<Handle>,
        integration: bool,
    ) -> Handle {
        Rc::new(Self {
            kind,
            name,
            text: RefCell::new(text),
            attrs: RefCell::new(attrs),
            children: RefCell::new(vec![]),
            parent: RefCell::new(Weak::new()),
            template,
            integration,
        })
    }
    pub fn tag(&self) -> &str {
        self.name.as_ref().map(|n| n.local.as_ref()).unwrap_or("")
    }
    pub fn attr(&self, name: &str) -> String {
        self.attrs
            .borrow()
            .iter()
            .find(|a| a.name.local.as_ref() == name)
            .map(|a| a.value.to_string())
            .unwrap_or_default()
    }
    pub fn detach(node: &Handle) {
        if let Some(parent) = node.parent.borrow().upgrade() {
            parent
                .children
                .borrow_mut()
                .retain(|n| !Rc::ptr_eq(n, node));
        }
        *node.parent.borrow_mut() = Weak::new();
    }
    pub fn siblings(node: &Handle) -> (Option<Handle>, Option<Handle>) {
        let Some(parent) = node.parent.borrow().upgrade() else {
            return (None, None);
        };
        let children = parent.children.borrow();
        let Some(index) = children.iter().position(|n| Rc::ptr_eq(n, node)) else {
            return (None, None);
        };
        (
            index.checked_sub(1).and_then(|i| children.get(i)).cloned(),
            children.get(index + 1).cloned(),
        )
    }
}
pub(super) struct Dom {
    root: Handle,
    nodes: RefCell<Vec<Handle>>,
}
impl Drop for Dom {
    fn drop(&mut self) {
        for node in self.nodes.get_mut().iter() {
            node.children.borrow_mut().clear();
        }
    }
}
impl Dom {
    pub fn parse(html: &str) -> Self {
        let root = Node::new(Kind::Document, None, String::new(), vec![], None, false);
        let sink = Self {
            root: root.clone(),
            nodes: RefCell::new(vec![root]),
        };
        parse_document(sink, Default::default()).one(format!(
            "<x-turndown id=\"turndown-root\">{html}</x-turndown>"
        ))
    }
    pub fn root(&self) -> Option<Handle> {
        self.nodes
            .borrow()
            .iter()
            .find(|n| n.tag() == "x-turndown" && n.attr("id") == "turndown-root")
            .cloned()
    }
    pub fn bounded(&self) -> bool {
        if self.nodes.borrow().len() > 100_000 {
            return false;
        }
        let mut stack = vec![(self.root.clone(), 0)];
        while let Some((node, depth)) = stack.pop() {
            if depth > 256 {
                return false;
            }
            stack.extend(
                node.children
                    .borrow()
                    .iter()
                    .map(|n| (n.clone(), depth + 1)),
            );
        }
        true
    }
    fn allocate(
        &self,
        kind: Kind,
        name: Option<QualName>,
        text: String,
        attrs: Vec<Attribute>,
        template: Option<Handle>,
        integration: bool,
    ) -> Handle {
        let node = Node::new(kind, name, text, attrs, template, integration);
        self.nodes.borrow_mut().push(node.clone());
        node
    }
    fn insert(&self, parent: &Handle, before: Option<&Handle>, child: NodeOrText<Handle>) {
        let node = match child {
            NodeOrText::AppendNode(node) => {
                Node::detach(&node);
                node
            }
            NodeOrText::AppendText(text) => {
                let children = parent.children.borrow();
                let index = before
                    .and_then(|n| children.iter().position(|c| Rc::ptr_eq(c, n)))
                    .unwrap_or(children.len());
                if let Some(previous) = index.checked_sub(1).and_then(|i| children.get(i))
                    && previous.kind == Kind::Text
                {
                    previous.text.borrow_mut().push_str(&text);
                    return;
                }
                drop(children);
                self.allocate(Kind::Text, None, text.to_string(), vec![], None, false)
            }
        };
        let mut children = parent.children.borrow_mut();
        let index = before
            .and_then(|n| children.iter().position(|c| Rc::ptr_eq(c, n)))
            .unwrap_or(children.len());
        *node.parent.borrow_mut() = Rc::downgrade(parent);
        children.insert(index, node);
    }
}
impl TreeSink for Dom {
    type Handle = Handle;
    type Output = Self;
    type ElemName<'a> = &'a QualName;
    fn finish(self) -> Self {
        self
    }
    fn parse_error(&self, _: Cow<'static, str>) {}
    fn get_document(&self) -> Handle {
        self.root.clone()
    }
    fn elem_name<'a>(&'a self, target: &'a Handle) -> &'a QualName {
        target.name.as_ref().expect("HTML parser element name")
    }
    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> Handle {
        let template = flags
            .template
            .then(|| self.allocate(Kind::Document, None, String::new(), vec![], None, false));
        self.allocate(
            Kind::Element,
            Some(name),
            String::new(),
            attrs,
            template,
            flags.mathml_annotation_xml_integration_point,
        )
    }
    fn create_comment(&self, text: StrTendril) -> Handle {
        self.allocate(Kind::Comment, None, text.to_string(), vec![], None, false)
    }
    fn create_pi(&self, _: StrTendril, data: StrTendril) -> Handle {
        self.create_comment(data)
    }
    fn append(&self, parent: &Handle, child: NodeOrText<Handle>) {
        self.insert(parent, None, child)
    }
    fn append_before_sibling(&self, sibling: &Handle, child: NodeOrText<Handle>) {
        let parent = sibling.parent.borrow().upgrade();
        if let Some(parent) = parent {
            self.insert(&parent, Some(sibling), child);
        }
    }
    fn append_based_on_parent_node(
        &self,
        element: &Handle,
        previous: &Handle,
        child: NodeOrText<Handle>,
    ) {
        if element.parent.borrow().upgrade().is_some() {
            self.append_before_sibling(element, child)
        } else {
            self.append(previous, child)
        }
    }
    fn append_doctype_to_document(&self, _: StrTendril, _: StrTendril, _: StrTendril) {}
    fn get_template_contents(&self, target: &Handle) -> Handle {
        target
            .template
            .as_ref()
            .expect("HTML template contents")
            .clone()
    }
    fn same_node(&self, a: &Handle, b: &Handle) -> bool {
        Rc::ptr_eq(a, b)
    }
    fn set_quirks_mode(&self, _: QuirksMode) {}
    fn add_attrs_if_missing(&self, target: &Handle, attrs: Vec<Attribute>) {
        let mut old = target.attrs.borrow_mut();
        for attr in attrs {
            if !old.iter().any(|a| a.name == attr.name) {
                old.push(attr);
            }
        }
    }
    fn remove_from_parent(&self, target: &Handle) {
        Node::detach(target)
    }
    fn reparent_children(&self, node: &Handle, parent: &Handle) {
        let children = node.children.borrow().clone();
        for child in children {
            self.append(parent, NodeOrText::AppendNode(child));
        }
    }
    fn is_mathml_annotation_xml_integration_point(&self, target: &Handle) -> bool {
        target.integration
    }
}
