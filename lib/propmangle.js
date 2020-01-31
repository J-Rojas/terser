/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.
  https://github.com/mishoo/UglifyJS2

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2012 (c) Mihai Bazon <mihai.bazon@gmail.com>

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

"use strict";
/*eslint-env node*/

import {
    defaults,
    push_uniq,
} from "./utils/index.js";
import { 
    addStrings, 
    mangle_helpers,     
    reserve_quoted_keys,
    expressionName,
    find_builtins,
    DEBUG
} from "./mangle.js";
import {
    AST_Call,    
    AST_Dot,
    AST_ObjectKeyVal,
    AST_ObjectProperty,
    AST_Sub, 
    AST_String,
    TreeTransformer,
    TreeWalker
} from "./ast.js";

function mangle_properties(ast, options, verbose) {
    options = defaults(options, {
        builtins: false,
        cache: null,
        chaining: false,
        debug: false,
        keep_quoted: false,
        only_cache: false,
        regex: null,
        mangle_pattern: null,
        reserved: null,
        undeclared: false,
        included: null,
        strings: [],
        excludeParents: [],
        includeParents: [],
        excludeTree: []
    }, true);

    var reserved_option = options.reserved;
    if (!Array.isArray(reserved_option)) reserved_option = [reserved_option];
    var reserved = new Set(reserved_option);
    var excludeParents_option = options.excludeParents;
    if (!Array.isArray(excludeParents_option)) excludeParents_option = [excludeParents_option];    
    var excludeParents = new Set(excludeParents_option.map(it => {
        if (typeof it === "string") {
            return it;
        } else {
            return it.name;
        }
    }));
    var excludeParentsMap = new Map(excludeParents_option.map(it => {
        if (typeof it === "string") {
            return [it, {scope: false}];
        } else {
            return [it.name, it];
        }
    }));
    var includeParents_option = options.includeParents;
    if (!Array.isArray(includeParents_option)) includeParents_option = [includeParents_option];    
    var includeParents = new Set(includeParents_option.map(it => {
        if (typeof it === "string") {
            return it;
        } else {
            return it.name;
        }
    }));
    var includeParentsMap = new Map(includeParents_option.map(it => {
        if (typeof it === "string") {
            return [it, {index: 0}];
        } else {
            return [it.name, it];
        }
    }));

    var excludeTree = new Set(options.excludeTree);

    // add Object.defineProperty call to includeParents
    includeParents.add("Object.defineProperty");
    includeParentsMap.set("Object.defineProperty", { index: 1 });

    if (!Array.isArray(options.strings)) options.strings = [];        
    var includedStrings = new Set(options.strings);

    //DEBUG(options, verbose);
    //DEBUG(excludeParents, verbose);
    //DEBUG(excludeParentsMap, verbose);
        
    if (!options.builtins) find_builtins(reserved);
    
    var {
        add,
        mangle,
        mangleStrings,
        keep_quoted_strict             
    } = mangle_helpers(options, reserved, options.cache ? options.cache.props : null);

    var excludedNodes = new Set();
    var excludeTreeNodes = new Set();

    // step 1: find candidates to mangle
    var walker = new TreeWalker();
    walker.visit = function(node) {

        if (excludeParents_option.length > 0 || includeParents_option.length > 0) {
            var key;
            var parent;
            if (node instanceof AST_ObjectKeyVal) {
                key = node.key;
                parent = walker.parent(1);
            } else if (node instanceof AST_ObjectProperty) {
                key = node.key.name;
                parent = node.expression;
            } else if (node instanceof AST_Dot) {
                key = node.property;
                parent = node.expression;
            }

            if (key) {
                if (excludeParents.has(key)) {            
                    DEBUG("Found excluded parent: " + key, verbose);
                    //console.log(parent);
                } 
                if (includeParents.has(key)) {
                    DEBUG("Found included parent: " + key, verbose);
                }
                
                var parentName = expressionName(parent);
                if (key == "uint32" && parent) {
                    DEBUG("class parent found: " + parent.__proto__.TYPE, verbose);                     
                    DEBUG(parent, verbose);
                }
                var parentExcluded = parentName && excludeParents.has(parentName);
                if (parentExcluded) {
                    var scope = excludeParentsMap.get(parentName).scope;
                    DEBUG("has parent excluded: " + key + " scope: " + scope, verbose);                     
                    if (scope === false) {
                        //scope is instance only
                        excludedNodes.add(node);
                    } else if (scope === "global") {
                        //scope is global, add to cache without name mangling
                        add(key, false);
                    }
                }

                var parentIncluded = parentName && includeParents.has(parentName);
                if (parentIncluded) {
                    DEBUG("has parent included: " + key, verbose);
                    add(key, true);
                }
            }
        }

        if (node instanceof AST_ObjectKeyVal) {
            if (typeof node.key == "string" &&
                (!keep_quoted_strict || !node.quote)) {
                add(node.key, true);
            }
        } else if (node instanceof AST_ObjectProperty) {
            // setter or getter, since KeyVal is handled above
            if (!keep_quoted_strict || !node.key.end.quote) { 
                var items, item;
                if (options.chaining && node.key.end.quote) {
                    items = node.key.name.split(".");
                    if (items.length > 0) {
                        while (items.length > 0) {
                            item = items.shift();
                            add(item, true);
                        }
                    }
                }
                
                if (!item)                    
                    add(node.key.name, true);                                  
            }
        } else if (node instanceof AST_Dot) {
            var declared = !!options.undeclared;
            if (!declared) {
                var root = node;
                while (root.expression) {
                    root = root.expression;
                }
                declared = !(root.thedef && root.thedef.undeclared);
            }
            if (declared &&
                (!keep_quoted_strict || !node.quote)) {
                add(node.property, true);
            }
        } else if (node instanceof AST_Sub) {  
            if (!keep_quoted_strict) {
                addStrings(node.property, add, true);
            }
        } else if (node instanceof AST_Call) {
            var str = node.expression.print_to_string();  
            if (excludeTree.has(str)) {
                excludeTreeNodes.add(node);
                DEBUG("excluded tree: '" + str + "'", verbose);
                return true; //do not descend
            } else if ((includeParents.has(str)) || 
                ((str = expressionName(node.expression)) && includeParents.has(str))) {
                DEBUG("include parent: '" + str + "'", verbose);
                DEBUG("   value: " + node.args[includeParentsMap.get(str).index].print_to_string(), verbose);
                addStrings(node.args[includeParentsMap.get(str).index], add, true);
            }
        } else if (node instanceof AST_String) {
            if (includedStrings.has(node.value)) {
                DEBUG("included string: '" + node.value + "'", verbose);
                add(node.value, true);
            }
        }

        return false;
    };
    ast.walk(walker);

    // step 2: transform the tree, renaming properties
    var excludeNodeStack = [];
    walker = new TreeTransformer(function(node) {
        if (excludedNodes.has(node)) {
            return;
        }
        if (excludeTreeNodes.has(node)) {
            excludeNodeStack.push(node);
        }
        if (excludeNodeStack.length > 0) {
            return;
        }
        if (node instanceof AST_ObjectKeyVal) {
            if (typeof node.key == "string" &&
                (!keep_quoted_strict || !node.quote)) {
                node.key = mangle(node.key);
            }
        } else if (node instanceof AST_ObjectProperty) {
            // setter or getter
            if (!keep_quoted_strict || !node.key.end.quote) {

                var items, item, prevItem;
                if (options.chaining && node.key.end.quote) {
                    items = node.key.name.split(".");                    
                    if (items.length > 0) {
                        var str = "";
                        while (items.length > 0) {
                            //check exclude parents
                            prevItem = item;                            
                            item = items.shift();
                            if (prevItem && excludeParents.has(prevItem)) {
                                str += item;
                            } else {
                                str += mangle(item); 
                            }
                            str += (items.length > 0 ? "." : "");
                        }                        
                        node.key.name = str;
                    }
                } 

                if (!item)
                    node.key.name = mangle(node.key.name);                      
            }
        } else if (node instanceof AST_Dot) {
            if (!keep_quoted_strict || !node.quote) {
                node.property = mangle(node.property);
            }
        } else if (!options.keep_quoted && node instanceof AST_Sub) {
            node.property = mangleStrings(node.property);
        } else if (node instanceof AST_Call) {
            var str;
            if (((str = node.expression.print_to_string()) && includeParents.has(str)) || 
                ((str = expressionName(node.expression)) && includeParents.has(str))) {                
                DEBUG("include parent: '" + str + "'", verbose);
                DEBUG("   value: " + node.args[includeParentsMap.get(str).index].print_to_string(), verbose);
                node.args[includeParentsMap.get(str).index] = mangleStrings(node.args[includeParentsMap.get(str).index]);    
            }
        } else if (node instanceof AST_String) {
            if (includedStrings.has(node.value)) {
                node.value = mangle(node.value);
            }
        }
    });
    walker.after = function(node) {        
        if (excludeNodeStack[excludeNodeStack.length - 1] == node) {
            excludeNodeStack.pop();
        }
    };
    return ast.transform(walker);
}

export {
    reserve_quoted_keys,
    mangle_properties,
};
