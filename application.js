(function() {
  var api = 'http' + (location.hostname === 'localhost' ? '://localhost:3000' : 's://offline-todo-api.herokuapp.com') + '/todos';
  var synchronizeInProgress, willSynchronizePromise;
  var db, input, ul;

  databaseOpen()
    .then(function() {
      input = document.getElementsByTagName('input')[0];
      ul = document.getElementsByTagName('ul')[0];
      document.body.addEventListener('submit', onSubmit);
      document.body.addEventListener('click', onClick);
    })
    .then(refreshView)
    .then(synchronize)
    .then(function() {
      var source = new EventSource(api+'/stream');
      source.addEventListener('message', synchronize);
    });

  function onClick(e) {
    if (e.target.hasAttribute('id')) {
      databaseTodosGetById(e.target.getAttribute('id'))
        .then(function(todo) {
          todo.deleted = true;
          return databaseTodosPut(todo);
        })
        .then(refreshView)
        .then(synchronize);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    var todo = { text: input.value, _id: String(Date.now()) };
    databaseTodosPut(todo)
      .then(function() {
        input.value = '';
      })
      .then(refreshView)
      .then(synchronize);
  }

  function refreshView() {
    return databaseTodosGet({ deleted: false }).then(renderAllTodos);
  }

  function renderAllTodos(todos) {
    var html = '';
    todos.forEach(function(todo) {
      html += todoToHtml(todo);
    });
    ul.innerHTML = html;
  }

  function todoToHtml(todo) {
    return '<li><button id="'+todo._id+'">delete</button>'+todo.text+'</li>';
  }

  function synchronize() {
    if (synchronizeInProgress) {
      if (!willSynchronizePromise) {
        willSynchronizePromise = new Promise(function(resolve, reject) {
          document.body.addEventListener('synchronized', function onSynchronized() {
            willSynchronizePromise = undefined;
            document.body.removeEventListener('synchronized', onSynchronized);
            resolve();
          });
        }).then(synchronize);
      }
      return willSynchronizePromise;
    }
    synchronizeInProgress = true;
    return Promise.all([serverTodosGet(), databaseTodosGet()])
      .then(function(results) {
        var promises = [];
        var remoteTodos = results[0].body;
        var localTodos = results[1];

        // Loop through local todos and if they haven't been
        // posted to the server, post them.
        promises = promises.concat(localTodos.map(function(todo) {
          var deleteTodo = function() {
            return databaseTodosDelete(todo);
          };

          // Has it been marked for deletion?
          if (todo.deleted) {
            return serverTodosDelete(todo).then(deleteTodo);
          }

          // If this is a todo that doesn't exist on the server try to create
          // it (if it fails because it's gone, delete it locally)
          if (!arrayContainsTodo(remoteTodos, todo)) {
            return serverTodosPost(todo)
              .catch(function(res) {
                if (res.status === 410) return deleteTodo();
              });
          }
        }));

        // Go through the todos that came down from the server,
        // we don't already have one, add it to the local db
        promises = promises.concat(remoteTodos.map(function(todo) {
          if (!arrayContainsTodo(localTodos, todo)) {
            return databaseTodosPut(todo);
          }
        }));
        return Promise.all(promises);
    }, function(err) {
      console.error(err, "Cannot connect to server");
    })
    .then(refreshView)
    .then(function() {
      synchronizeInProgress = false;
      document.body.dispatchEvent(new Event('synchronized'));
    });
  }

  function arrayContainsTodo(array, todo) {
    return array.some(function(arrayTodo) {
      return arrayTodo._id === todo._id;
    });
  }

  function databaseOpen() {
    return new Promise(function(resolve, reject) {
      var version = 1;
      var request = indexedDB.open('todos', version);
      request.onupgradeneeded = function(e) {
        db = e.target.result;
        e.target.transaction.onerror = reject;
        db.createObjectStore('todo', { keyPath: '_id' });
      };
      request.onsuccess = function(e) {
        db = e.target.result;
        resolve();
      };
      request.onerror = reject;
    });
  }

  function databaseTodosPut(todo) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.put(todo);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function databaseTodosGet(query) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');

      // Get everything in the store
      var keyRange = IDBKeyRange.lowerBound(0);
      var cursorRequest = store.openCursor(keyRange);

      // This fires once per row in the store, so for simplicity collect the data
      // in an array (data) and send it pass it in the resolve call in one go
      var data = [];
      cursorRequest.onsuccess = function(e) {
        var result = e.target.result;

        // If there's data, add it to array
        if (result) {
          if (!query || (query.deleted === true && result.value.deleted) || (query.deleted === false && !result.value.deleted)) {
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

  function databaseTodosGetById(id) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.get(id);
      request.onsuccess = function(e) {
        var result = e.target.result;
        resolve(result);
      };
      request.onerror = reject;
    });
  }

  function databaseTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      var transaction = db.transaction(['todo'], 'readwrite');
      var store = transaction.objectStore('todo');
      var request = store.delete(todo._id);
      request.onsuccess = resolve;
      request.onerror = reject;
    });
  }

  function serverTodosGet(_id) {
    return new Promise(function(resolve, reject) {
      superagent.get(api+'/' + (_id ? _id : ''))
        .end(function(err, res) {
          if (!err && res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosPost(todo) {
    return new Promise(function(resolve, reject) {
      superagent.post(api)
        .send(todo)
        .end(function(res) {
          if (res.ok) resolve(res);
          else reject(res);
        });
    });
  }

  function serverTodosDelete(todo) {
    return new Promise(function(resolve, reject) {
      superagent.del(api + '/' + todo._id)
        .end(function(res) {
          if (res.ok) resolve(res);
          else reject();
        });
    });
  }
}());
