(function() {
  var host = location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://offline-todo-api.herokuapp.com';

  var request = superagent;

  // Some global variables (database, references to key UI elements)
  var db, input, ul;

  databaseOpen()
    .then(function() {
      input = document.getElementsByTagName('input')[0];
      ul = document.getElementsByTagName('ul')[0];
      document.body.addEventListener('submit', onSubmit);
      document.body.addEventListener('click', onClick);
      return refreshView()
    })
    .then(synchronize);

  function onClick(e) {

    // We'll assume any element with an ID attribute
    // is a todo item. Don't try this at home!
    if (e.target.hasAttribute('id')) {

      // Note because the id is stored in the DOM, it becomes
      // a string so need to make it an integer again
      databaseTodosGetByLocalId(parseInt(e.target.getAttribute('id'), 10))
        .then(function(todo) {
          todo.deleted = true;
          todo.updated = Date.now();
          return databaseTodosPut(todo)
        })
        .then(refreshView)
        .then(synchronize);
    }
  }

  function renderAllTodos(todos) {
    var html = '';
    todos.forEach(function(todo) {
      html += todoToHtml(todo);
    });
    ul.innerHTML = html;
  }

  function todoToHtml(todo) {
    return '<li><button id="'+todo.localId+'">delete</button>'+todo.text+'</li>';
  }

  function onSubmit(e) {
    e.preventDefault();
    var todo = {
      text: input.value,
      updated: Date.now(),
      remoteId: undefined
    };
    databaseTodosPut(todo)
      // After new todos have been added - rerender all the todos
      .then(refreshView)
      .then(function() {
        synchronize();
        input.value = '';
      });
  }

  function databaseOpen() {
    return new Promise(function(resolve, reject) {
      // Open a database, specify the name and version
      var version = 1;
      var request = indexedDB.open('todos', version);

      // Run migrations if necessary
      request.onupgradeneeded = function(e) {
        db = e.target.result;
        e.target.transaction.onerror = reject;

        var todoStore = db.createObjectStore('todo', { keyPath: 'localId', autoIncrement: true });
        todoStore.createIndex('remoteId', 'remoteId', { unique: false });
      };

      request.onsuccess = function(e) {
        db = e.target.result;
        resolve();
      };
      request.onerror = reject;
    });
  }

  function synchronize() {
    return new Promise(function(resolve, reject) {
      request.get(host+'/todos', function(err, res) {
        if (err) return console.error("Cannot connect to server");
        var remoteTodos = res.body;

        return databaseTodosGetByDeleted(undefined)
          .then(function(localTodos) {
            var localTodosRemoteIds = localTodos
              .map(function(todo) { return todo.remoteId; });

            // Loop through local todos and if they haven't been
            // posted to the server, post them.
            localTodos.forEach(function(todo) {

              // If the remote id exists maybe update the text try to update it
              if (todo.remoteId) {

                // Has it been marked for deletion?
                if (todo.deleted) {
                  serverTodosDelete(todo)
                    .then(function() {
                      databaseTodosDelete(todo);
                    });

                // Otherwise try to update it
                } else {
                  serverTodosUpdate(todo)

                    // Only need to handle the error case (probably a conflict)
                    .catch(function(res) {
                      request.get(host+'/todos/'+todo.remoteId)
                        .end(function(res) {
                          // Todo has been deleted, delete it locally too
                          if (res.status === 404) {
                            databaseTodosDelete(todo)
                              .then(refreshView);

                          // Otherwise update it with whatever the server thinks is right
                          } else {
                            databaseTodosPut({
                              localId: todo.localId,
                              remoteId: todo.remoteId,
                              text: res.body.text,
                              updated: res.body.updated
                            }).then(refreshView);
                          }
                        });
                    });
                }

              // Otherwise create on the remote server & update local id
              } else {
                serverTodosAdd(todo)
                  .then(function(res) {
                      todo.remoteId = res.text;
                      databaseTodosPut(todo)
                        .then(refreshView);
                  })
                  .catch(function(res) {
                    if (res.status === 400) {
                      databaseTodosDelete(todo)
                        .then(refreshView);
                    }
                  });
              }
            });
            remoteTodos.forEach(function(todo) {
              var localCopyIndex = localTodosRemoteIds.indexOf(todo._id);

              // We don't have todo, maybe create it?
              if (localCopyIndex === -1) {
                databaseTodosPut({
                  text: todo.text,
                  remoteId: todo._id,
                  updated: todo.updated,
                }).then(refreshView);
              }
            });
          });
      });
    });
  }

  function refreshView() {
    return databaseTodosGetByDeleted(false)
      .then(renderAllTodos);
  }

  function databaseTodosPut(todo, callback) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.put(todo);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function databaseTodosGetByLocalId(id, callback) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.get(id);
      request.onsuccess = function(e) {
        var result = e.target.result;
        resolve(result);
      }
      request.onerror = reject;
    });
  };

  function databaseTodosGetByDeleted(deleted) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');

      // Get everything in the store
      var keyRange = IDBKeyRange.lowerBound(0);
      var cursorRequest = store.openCursor(keyRange);

      // This fires once per row in the store, so for simplicity
      // collect the data in an array (data) and send it pass it
      // in the callback in one go
      var data = [];
      cursorRequest.onsuccess = function(e) {
        var result = e.target.result;

        // If there's data, add it to array
        if (result) {
          if (deleted === undefined || (deleted === true && result.value.deleted) || (deleted === false && !result.value.deleted)) {
            data.push(result.value);
          }
          result.continue();

        // Reach the end of the data
        } else {
          resolve(data);
        }
      };
    });
  }

  function databaseTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.delete(todo.localId);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function serverTodosAdd(todo) {
    return new Promise(function(resolve, reject) {
      request.post(host+'/todos')
        .send({ text: todo.text, updated: todo.updated })
        .end(function(res) {
          if (res.ok) {
            resolve(res);

          // If the server rejects the todo (eg. blank text) reject it
          } else if (res.status === 400) {
            reject(res);
          }
        });
    });
  }

  function serverTodosUpdate(todo) {;
    return new Promise(function(resolve, reject) {
      request.put(host+'/todos/'+todo.remoteId)
        .send({ text: todo.text, updated: todo.updated })
        .end(function(res) {
          if (res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      request.del(host+'/todos/'+todo.remoteId)
        .send({ text: todo.text, updated: todo.updated })
        .end(function(res) {
          if (res.ok) resolve();
          else reject();
        });
    });
  }

}());
